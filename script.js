/* ==========================================================================
   FIREBASE IMPORTS
   ========================================================================== */
import { auth, db } from './firebase-config.js';
import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    deleteUser,
    onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
    doc, getDoc, setDoc, deleteDoc,
    collection, query, where, getDocs, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const TEAM_LEADER_INVITE_CODE = 'PLDT-TL-2026';
const QUALITY_INVITE_CODE = 'PLDT-QA-2026'; 

let lobChartInstance = null;
let siteChartInstance = null;

/* ==========================================================================
   FIRESTORE BATCH HELPERS (Concurrent Writes)
   ========================================================================== */
async function batchWriteDocs(collectionName, docs, idFn) {
    const chunks = [];
    for (let i = 0; i < docs.length; i += 400) chunks.push(docs.slice(i, i + 400));
    
    const promises = chunks.map(chunk => {
        const batch = writeBatch(db);
        chunk.forEach(d => {
            const ref = idFn ? doc(db, collectionName, idFn(d)) : doc(collection(db, collectionName));
            batch.set(ref, d);
        });
        return batch.commit();
    });

    await Promise.all(promises);
}

async function clearCollection(collectionName) {
    const snap = await getDocs(collection(db, collectionName));
    const ids = snap.docs.map(d => d.id);
    const promises = [];

    for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach(id => batch.delete(doc(db, collectionName, id)));
        promises.push(batch.commit());
    }

    await Promise.all(promises);
}

async function replaceAuditData(rows, onProgress = null) {
    const report = (phase, done, total) => {
        if (typeof onProgress === 'function') onProgress(phase, done, total);
    };

    // Helper: commit an array of already-built batches concurrently and
    // report progress as each one resolves.
    async function commitBatchesConcurrently(phase, batches) {
        const total = batches.reduce((s, b) => s + b.count, 0);
        report(phase, 0, total);
        let done = 0;
        await Promise.all(batches.map(({ batch, count }) =>
            batch.commit().then(() => {
                done += count;
                report(phase, done, total);
            })
        ));
    }

    // DELETE — read every doc that actually exists rather than relying on a
    // stored count.  A previous upload with more rows than the current one
    // would leave "ghost" rows (row_10603 to row_N) that never got deleted
    // under the old index-range approach, silently corrupting every aggregate.
    report('Removing previous audit data', 0, 1);
    const existingSnap = await getDocs(collection(db, 'auditData'));
    if (existingSnap.size > 0) {
        const deleteBatches = [];
        let batch = writeBatch(db);
        let batchCount = 0;
        existingSnap.docs.forEach((d) => {
            batch.delete(d.ref);
            batchCount++;
            if (batchCount === 400) {
                deleteBatches.push({ batch, count: batchCount });
                batch = writeBatch(db);
                batchCount = 0;
            }
        });
        if (batchCount > 0) deleteBatches.push({ batch, count: batchCount });
        await commitBatchesConcurrently('Removing previous audit data', deleteBatches);
    }

    // WRITE new rows
    if (rows.length > 0) {
        const writeBatches = [];
        for (let i = 0; i < rows.length; i += 400) {
            const chunk = rows.slice(i, i + 400);
            const b = writeBatch(db);
            chunk.forEach((row, idx) => b.set(doc(db, 'auditData', 'row_' + (i + idx)), row));
            writeBatches.push({ batch: b, count: chunk.length });
        }
        await commitBatchesConcurrently('Uploading audit data', writeBatches);
    }

    // Update meta — deletion no longer depends on this being accurate,
    // but it is still shown in status messages so keep it up to date.
    const metaRef = doc(db, 'meta', 'auditData');
    await setDoc(metaRef, { count: rows.length, updatedAt: Date.now() });
}

/* ==========================================================================
   SESSION & STATE
   ========================================================================== */
let currentSession = null; // { uid, email, role, agentName, agentId }
let cachedAuditRows = [];
let lastUnmatchedRows = []; // { name, id, source: 'upload' | 'resync' }

function getNormalizedRole(roleStr) {
    if (!roleStr) return '';
    return String(roleStr).trim().toLowerCase().replace(/\s+/g, '_');
}

/* ==========================================================================
   AUTH & USER MANAGEMENT
   ========================================================================== */
function switchAuthTab(which) {
    const tabLogin = document.getElementById('tabLogin');
    const tabSignup = document.getElementById('tabSignup');
    const loginPane = document.getElementById('loginPane');
    const signupPane = document.getElementById('signupPane');

    if (tabLogin) tabLogin.classList.toggle('active', which === 'login');
    if (tabSignup) tabSignup.classList.toggle('active', which === 'signup');
    if (loginPane) loginPane.style.display = which === 'login' ? 'block' : 'none';
    if (signupPane) signupPane.style.display = which === 'signup' ? 'block' : 'none';
}

let signupRole = 'agent';
function setSignupRole(role) {
    signupRole = role;
    const roleAgentLabel = document.getElementById('roleAgentLabel');
    const roleTeamLeaderLabel = document.getElementById('roleTeamLeaderLabel');
    const roleQualityLabel = document.getElementById('roleQualityLabel');
    const supervisorCodeGroup = document.getElementById('supervisorCodeGroup');
    const supervisorCodeLabel = document.getElementById('supervisorCodeLabel');

    if (roleAgentLabel) roleAgentLabel.classList.toggle('checked', role === 'agent');
    if (roleTeamLeaderLabel) roleTeamLeaderLabel.classList.toggle('checked', role === 'team_leader');
    if (roleQualityLabel) roleQualityLabel.classList.toggle('checked', role === 'quality');
    
    const needsCode = role === 'team_leader' || role === 'quality';
    if (supervisorCodeGroup) supervisorCodeGroup.style.display = needsCode ? 'block' : 'none';
    if (needsCode && supervisorCodeLabel) {
        supervisorCodeLabel.textContent = role === 'team_leader' ? 'Team Leader Invite Code' : 'Quality Invite Code';
    }
}

function showAuthMsg(elId, text, ok) {
    const el = document.getElementById(elId);
    if (!el) return;
    el.textContent = text;
    el.className = 'auth-msg ' + (ok ? 'ok' : 'error');
}

let authFlowInProgress = false;

async function handleSignup() {
    const emailEl = document.getElementById('signupEmail');
    const pwEl = document.getElementById('signupPassword');
    const pw2El = document.getElementById('signupPassword2');
    
    const email = emailEl ? emailEl.value.trim().toLowerCase() : '';
    const pw = pwEl ? pwEl.value : '';
    const pw2 = pw2El ? pw2El.value : '';

    if (!email || !email.includes('@')) return showAuthMsg('signupMsg', 'Enter a valid work email.', false);
    if (pw.length < 6) return showAuthMsg('signupMsg', 'Password must be at least 6 characters.', false);
    if (pw !== pw2) return showAuthMsg('signupMsg', 'Passwords do not match.', false);

    authFlowInProgress = true;
    try {
        if (signupRole === 'team_leader' || signupRole === 'quality') {
            const requiredCode = signupRole === 'team_leader' ? TEAM_LEADER_INVITE_CODE : QUALITY_INVITE_CODE;
            const codeEl = document.getElementById('supervisorCode');
            const code = codeEl ? codeEl.value.trim() : '';
            if (code !== requiredCode) return showAuthMsg('signupMsg', 'Invalid invite code.', false);

            let cred;
            try {
                cred = await createUserWithEmailAndPassword(auth, email, pw);
            } catch (err) {
                return showAuthMsg('signupMsg', friendlyAuthError(err), false);
            }
            await setDoc(doc(db, 'users', cred.user.uid), { email, role: signupRole });
            await signOut(auth);
            showAuthMsg('signupMsg', `${signupRole === 'team_leader' ? 'Team Leader' : 'Quality'} account created. Log in now.`, true);
            clearSignupForm();
            setTimeout(() => switchAuthTab('login'), 1200);
            return;
        }

        let cred;
        try {
            cred = await createUserWithEmailAndPassword(auth, email, pw);
        } catch (err) {
            return showAuthMsg('signupMsg', friendlyAuthError(err), false);
        }

        try {
            const rosterSnap = await getDoc(doc(db, 'roster', email));
            if (!rosterSnap.exists()) {
                await deleteUser(cred.user);
                return showAuthMsg('signupMsg', 'Email not on agent roster. Ask supervisor to add you first.', false);
            }
            const match = rosterSnap.data();

            await setDoc(doc(db, 'users', cred.user.uid), {
                email,
                role: 'agent',
                agentName: match.agentName,
                agentId: match.agentId || ''
            });
            await signOut(auth);
            showAuthMsg('signupMsg', `Account created & matched to "${match.agentName}". You can log in now.`, true);
            clearSignupForm();
            setTimeout(() => switchAuthTab('login'), 1200);
        } catch (err) {
            try { await deleteUser(cred.user); } catch (e2) {}
            showAuthMsg('signupMsg', friendlyAuthError(err), false);
        }
    } finally {
        authFlowInProgress = false;
    }
}

function clearSignupForm() {
    ['signupEmail', 'signupPassword', 'signupPassword2', 'supervisorCode'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
}

async function quickAccess(role) {
    const email = prompt(`Enter ${role.replace('_', ' ')} email:`);
    const password = prompt("Enter password:");

    if (!email || !password) return;

    authFlowInProgress = true;
    try {
        const cred = await signInWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
        const profileSnap = await getDoc(doc(db, 'users', cred.user.uid));
        
        if (!profileSnap.exists()) {
            return showAuthMsg('loginMsg', 'No user profile document found in Firestore for this account.', false);
        }
        currentSession = { uid: cred.user.uid, ...profileSnap.data() };
        await enterApp();
    } catch (err) {
        showAuthMsg('loginMsg', friendlyAuthError(err), false);
    } finally {
        authFlowInProgress = false;
    }
}

async function handleLogin() {
    const emailEl = document.getElementById('loginEmail');
    const pwEl = document.getElementById('loginPassword');
    const email = emailEl ? emailEl.value.trim().toLowerCase() : '';
    const pw = pwEl ? pwEl.value : '';

    if (!email || !pw) return showAuthMsg('loginMsg', 'Enter email and password.', false);

    authFlowInProgress = true;
    try {
        const cred = await signInWithEmailAndPassword(auth, email, pw);
        const profileSnap = await getDoc(doc(db, 'users', cred.user.uid));
        if (!profileSnap.exists()) {
            await signOut(auth);
            return showAuthMsg('loginMsg', 'No user profile found in database (/users/' + cred.user.uid + ').', false);
        }
        currentSession = { uid: cred.user.uid, ...profileSnap.data() };
        if (emailEl) emailEl.value = '';
        if (pwEl) pwEl.value = '';
        await enterApp();
    } catch (err) {
        showAuthMsg('loginMsg', friendlyAuthError(err), false);
    } finally {
        authFlowInProgress = false;
    }
}

function logout() {
    signOut(auth);
}

function friendlyAuthError(err) {
    const code = err && err.code ? err.code : '';
    if (code.includes('email-already-in-use')) return 'An account with this email already exists.';
    if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Incorrect email or password.';
    if (code.includes('weak-password')) return 'Password must be at least 6 characters.';
    if (code.includes('invalid-email')) return 'Enter a valid email address.';
    return 'Authentication error: ' + (err && err.message ? err.message : 'Please try again.');
}

function resetToLoggedOutState() {
    currentSession = null;
    cachedAuditRows = [];

    const appScreen = document.getElementById('appScreen');
    const authScreen = document.getElementById('authScreen');
    const sessionChip = document.getElementById('sessionChip');

    if (appScreen) appScreen.style.display = 'none';
    if (authScreen) authScreen.style.display = 'flex';
    if (sessionChip) sessionChip.style.display = 'none';

    clearSignupForm();
    switchAuthTab('login');
}

onAuthStateChanged(auth, async (user) => {
    if (authFlowInProgress) return;

    if (!user) {
        resetToLoggedOutState();
        return;
    }

    try {
        const profileSnap = await getDoc(doc(db, 'users', user.uid));
        if (!profileSnap.exists()) {
            console.error(`User authenticated (${user.uid}), but no user record in /users collection.`);
            await signOut(auth);
            return;
        }
        currentSession = { uid: user.uid, ...profileSnap.data() };
        await enterApp();
    } catch (err) {
        console.error("Auth state error:", err);
    }
});

async function enterApp() {
    if (!currentSession) return;

    const appScreen = document.getElementById('appScreen');
    const authScreen = document.getElementById('authScreen');
    const sessionChip = document.getElementById('sessionChip');
    const sessionLabel = document.getElementById('sessionLabel');

    if (authScreen) authScreen.style.display = 'none';
    if (appScreen) appScreen.style.display = 'flex';
    if (sessionChip) sessionChip.style.display = 'flex';

    const normalizedRole = getNormalizedRole(currentSession.role);
    const roleLabels = { quality: '👤 Quality · ', team_leader: '👤 Team Leader · ', supervisor: '👤 Quality · ', agent: '👤 Agent · ' };
    
    if (sessionLabel) {
        sessionLabel.textContent = (roleLabels[normalizedRole] || '👤 ') + currentSession.email;
    }

    const canViewDashboard = ['quality', 'team_leader', 'supervisor'].includes(normalizedRole);
    const canUpload = ['quality', 'supervisor'].includes(normalizedRole);

    const supervisorSidebar = document.getElementById('supervisorSidebar');
    const supervisorView = document.getElementById('supervisorView');
    const agentView = document.getElementById('agentView');
    const uploadIconBtn = document.getElementById('uploadIconBtn');

    if (supervisorSidebar) supervisorSidebar.style.display = canViewDashboard ? 'flex' : 'none';
    if (supervisorView) supervisorView.style.display = canViewDashboard ? 'flex' : 'none';
    if (agentView) agentView.style.display = canViewDashboard ? 'none' : 'flex';
    if (uploadIconBtn) uploadIconBtn.style.display = canUpload ? 'flex' : 'none';

    if (canViewDashboard) {
        if (canUpload) await refreshRosterStatus();
        const rows = await loadAllAuditData();
        console.log(`Loaded ${rows.length} rows for Supervisor view.`);
        
        const dataStatus = document.getElementById('dataStatus');
        if (dataStatus) {
            dataStatus.innerHTML = rows.length 
                ? `✅ ${rows.length} audit rows loaded.` 
                : `⚠️ 0 rows in auditData collection. Use the upload button to import data.`;
        }
        
        populateDropdownOptions(rows, true); // true = auto-select latest weekending on login
        filterData();
    } else {
        await renderAgentView();
    }
}

/* ==========================================================================
   HIT PARAMETER & FORMATTING HELPERS
   ========================================================================== */
const NON_ISSUE_VALUES = new Set(['', 'NO OPPORTUNITY', 'NA', 'N/A', 'NO', 'NONE']);

const HIT_PARAMS = [
    { col: 'IRRELEVANT SOLUTION', category: 'Reliable', label: 'Irrelevant solution given', type: 'descriptive' },
    { col: 'INCOMPLETE SOLUTION', category: 'Reliable', label: 'Incomplete solution given', type: 'descriptive' },
    { col: 'UNTIMELY SOLUTION ( ZTP)', category: 'Reliable', label: 'Untimely solution (ZTP)', type: 'descriptive' },
    { col: 'UNCLEAR SOLUTION', category: 'Reliable', label: 'Unclear solution given', type: 'descriptive' },
    { col: 'Poor Listening Skills?', category: 'Personable', label: 'Poor listening skills', type: 'descriptive' },
    { col: 'Customer Validation and Empathy Gap?', category: 'Personable', label: 'Empathy / validation gap', type: 'descriptive' },
    { col: 'Did not adjust the tone/pace to match the customer?', category: 'Personable', label: 'Tone/pace not matched to customer', type: 'descriptive' },
    { col: 'Did not adjust to the customers language?', category: 'Personable', label: 'Language not adjusted to customer', type: 'descriptive' },
    { col: 'Negative Words, Phrasing and Limitations?', category: 'Personable', label: 'Negative words / phrasing used', type: 'descriptive' },
    { col: 'Unfriendly/discourteous/sarcastic?', category: 'Personable', label: 'Unfriendly, discourteous, or sarcastic tone', type: 'descriptive' },
    { col: 'Sounded transactional or robotic?', category: 'Personable', label: 'Sounded transactional or robotic', type: 'descriptive' },
    { col: 'FAST: Were there other Agent factors observed that affected the customer experience?', category: 'Fast', label: 'Other agent factor slowed the resolution', type: 'descriptive' },
    { col: 'DID WE FOLLOW THE CUSTOMER AUTHENTICATION PROCESS?', category: 'Safe & Secure', label: 'Customer authentication process missed', type: 'descriptive' },
    { col: 'DID WE FOLLOW THE DATA PRIVACY POLICY?', category: 'Safe & Secure', label: 'Data privacy policy not followed', type: 'descriptive' },
    { col: 'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?', category: 'Safe & Secure', label: 'Customer info not updated in tool', type: 'descriptive' },
    { col: 'DID WE FOLLOW THE CSAT/NPS PROCESS?', category: 'Safe & Secure', label: 'CSAT/NPS process not followed', type: 'descriptive' },
    { col: 'DID WE FOLLOW THE SYSTEM DOCUMENTATION PROCESS?', category: 'Safe & Secure', label: 'System documentation process missed', type: 'descriptive' },
    { col: 'DID WE FOLLOW THE SYSTEM TAGGING PROCESS?', category: 'Safe & Secure', label: 'System tagging process missed', type: 'descriptive' },
    { col: 'DID WE FOLLOW CORRECT GRAMMAR, TECHNICAL WRITING & THE PRESCRIBED LANGUAGE?', category: 'Safe & Secure', label: 'Grammar / prescribed language standard missed', type: 'descriptive' },
    { col: "IS THIS A POTENTIAL CUSTOMER MISTREAT?", category: 'Mistreat', label: 'Potential customer mistreat flagged', type: 'descriptive' }
];

function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normVal(v) {
    return (v === undefined || v === null) ? '' : String(v).trim().toUpperCase();
}

function normalizeName(str) {
    return String(str || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[.,'-]/g, ' ')
        .replace(/\b(JR|SR|II|III|IV)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getRowIssues(row) {
    const issues = [];
    HIT_PARAMS.forEach(p => {
        const raw = row[p.col];
        const v = normVal(raw);
        if (!v) return;

        if (p.type === 'boolean') {
            if (v === p.hitValue) issues.push({ label: p.label, category: p.category });
            return;
        }

        if (!NON_ISSUE_VALUES.has(v)) {
            const detail = v !== 'YES' ? String(raw).trim() : '';
            issues.push({ label: detail ? `${p.label} — ${detail}` : p.label, category: p.category });
        }
    });
    return issues;
}

/* ==========================================================================
   WORKBOOK PARSER
   ========================================================================== */
function readWorkbookFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                resolve(XLSX.read(data, { type: 'array' }));
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function sheetToJson(ws) {
    // Some cleaned Excel files retain formatting through column XFD.
    // Limit parsing to the last real header cell to avoid freezing the browser.
    // Only look at row-0 addresses directly instead of scanning every
    // populated cell in the sheet (which scales with total rows x columns).
    const ref = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    let lastHeaderCol = 0;
    for (let c = 0; c <= ref.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
        if (cell && cell.v !== undefined && String(cell.v).trim() !== '') {
            lastHeaderCol = c;
        }
    }
    const safeRange = { s: { r: 0, c: 0 }, e: { r: ref.e.r, c: lastHeaderCol } };
    return XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, range: safeRange });
}

function resolveSheetName(wb, preferSheetKeywords) {
    if (!preferSheetKeywords || !preferSheetKeywords.length) return wb.SheetNames[0] || null;
    const keywords = Array.isArray(preferSheetKeywords) ? preferSheetKeywords : [preferSheetKeywords];
    for (const kw of keywords) {
        const found = wb.SheetNames.find(n => n.trim().toUpperCase() === String(kw).trim().toUpperCase())
            || wb.SheetNames.find(n => n.toUpperCase().includes(String(kw).toUpperCase()));
        if (found) return found;
    }
    return null;
}

async function parseWorkbookFile(file, preferSheetKeywords = []) {
    const wb = await readWorkbookFile(file);
    const sheetName = resolveSheetName(wb, preferSheetKeywords) || wb.SheetNames[0];
    return sheetToJson(wb.Sheets[sheetName]);
}

// Reads several named sheet groups out of one workbook in a single pass.
// sheetGroups: [{ key: 'active', keywords: ['ROSTER - ACTIVE', 'ROSTER'] }, ...]
// Returns { active: [...rows], termed: [...rows] } — a group with no matching
// sheet resolves to an empty array rather than throwing.
async function parseWorkbookMultiSheet(file, sheetGroups) {
    const wb = await readWorkbookFile(file);
    const result = {};
    sheetGroups.forEach(({ key, keywords }) => {
        const sheetName = resolveSheetName(wb, keywords);
        result[key] = sheetName ? sheetToJson(wb.Sheets[sheetName]) : [];
    });
    return result;
}

function findHeader(row, candidates) {
    if (!row) return null;
    const keys = Object.keys(row);
    
    for (const cand of candidates) {
        const hit = keys.find(k => k.trim().toLowerCase() === cand.trim().toLowerCase());
        if (hit) return hit;
    }
    for (const cand of candidates) {
        const hit = keys.find(k => k.trim().toLowerCase().includes(cand.trim().toLowerCase()));
        if (hit) return hit;
    }
    return null;
}

function findHeaderByWords(row, wordGroups) {
    if (!row) return null;
    const keys = Object.keys(row);
    const clean = v => String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    for (const group of wordGroups) {
        const words = group.map(clean);
        const hit = keys.find(k => words.every(w => clean(k).includes(w)));
        if (hit) return hit;
    }
    return null;
}

function normalizeEmployeeId(value) {
    return String(value || '').trim().replace(/\.0$/, '').replace(/\s+/g, '');
}

/* ==========================================================================
   DATA UPLOADS & RESYNC
   ========================================================================== */
function buildRosterEntries(rows, status) {
    if (!rows.length) return { rows: [], error: null };

    const emailKey = findHeader(rows[0], ['PLDT/SMART Domain v2', 'PLDT/SMART Domain', 'Domain', 'Email', 'Work Email', 'Conduent Email Address', 'Email Address']);
    const nameKey = findHeader(rows[0], ['Employee Name', 'Agent Name', 'AGENT/OFFICER NAME', 'Name', 'Full Name']);
    const idKey = findHeader(rows[0], ['Win ID', 'Winid', 'WIN ID', 'ID', 'Employee ID', 'Agent ID']);
    const supervisorKey = findHeader(rows[0], ['Supervisor', 'Supervisor Name', 'Immediate Supervisor', 'Team Leader', 'TEAM LEADER', 'TL Name', 'Sup Name', 'Reporting Manager', 'Manager Name']) || findHeaderByWords(rows[0], [['supervisor'], ['team', 'leader'], ['reporting', 'manager'], ['manager', 'name']]);

    if (!nameKey) {
        return { rows: [], error: `Missing an Employee/Agent Name column on the ${status} sheet.` };
    }

    const entries = rows
        .map(r => ({
            email: emailKey ? String(r[emailKey] || '').trim().toLowerCase() : '',
            agentName: String(r[nameKey] || '').trim(),
            agentId: idKey ? String(r[idKey] || '').trim() : '',
            teamLeader: supervisorKey ? String(r[supervisorKey] || '').trim() : '',
            status
        }))
        .filter(r => r.agentName && (r.email || r.agentId));

    return { rows: entries, error: null };
}

function rosterDocId(entry) {
    if (entry.email) return entry.email;
    if (entry.agentId) return 'id_' + normalizeEmployeeId(entry.agentId);
    return 'name_' + normalizeName(entry.agentName).replace(/\s+/g, '_').toLowerCase();
}

async function handleRosterUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const rosterStatus = document.getElementById('rosterStatus');
    if (rosterStatus) rosterStatus.textContent = 'Processing ' + file.name + '...';

    try {
        // Reads BOTH the active-employee sheet and the termed/separated sheet
        // (if present) so historical audits for agents who have since left
        // still resolve to a Team Leader / status instead of showing up as
        // "unmatched" and risking exclusion from score reporting.
        const { active: activeRows, termed: termedRows } = await parseWorkbookMultiSheet(file, [
            { key: 'active', keywords: ['ROSTER - ACTIVE', 'ROSTER', 'DOMAIN', 'MASTER'] },
            { key: 'termed', keywords: ['TERMED', 'TERMINATED', 'SEPARATED', 'ATTRITION'] }
        ]);

        if (!activeRows.length && !termedRows.length) {
            throw new Error('Excel file appears empty, or no Active/Termed roster sheet was found.');
        }

        const activeResult = buildRosterEntries(activeRows, 'ACTIVE');
        const termedResult = buildRosterEntries(termedRows, 'TERMED');

        if (activeResult.error && !activeResult.rows.length && !termedResult.rows.length) {
            throw new Error(activeResult.error);
        }

        // Active roster wins if the same person somehow appears on both sheets
        // (e.g. a rehire, or a termination sheet that hasn't been trimmed yet).
        const activeEmails = new Set(activeResult.rows.map(r => r.email).filter(Boolean));
        const activeIds = new Set(activeResult.rows.map(r => normalizeEmployeeId(r.agentId)).filter(Boolean));
        const activeNames = new Set(activeResult.rows.map(r => normalizeName(r.agentName)));

        const termedDeduped = termedResult.rows.filter(r =>
            !(r.email && activeEmails.has(r.email)) &&
            !(r.agentId && activeIds.has(normalizeEmployeeId(r.agentId))) &&
            !activeNames.has(normalizeName(r.agentName))
        );

        const roster = activeResult.rows.concat(termedDeduped);
        if (!roster.length) {
            throw new Error('No usable roster rows found (need at least a Name plus Email or ID).');
        }

        await clearCollection('roster');
        await batchWriteDocs('roster', roster, rosterDocId);

        const withSupervisor = roster.filter(r => r.teamLeader).length;
        const summary = `✅ Roster uploaded: ${activeResult.rows.length} active + ${termedDeduped.length} termed = ${roster.length} agents; ${withSupervisor} with Supervisor/Team Leader.`;
        if (rosterStatus) rosterStatus.innerHTML = `${summary} Auto-syncing existing audits...`;
        await resyncAgentEmails();
        if (rosterStatus) rosterStatus.innerHTML = `${summary} Existing audits were automatically synchronized.`;
    } catch (err) {
        console.error(err);
        if (rosterStatus) rosterStatus.innerHTML = `⚠️ Roster upload failed: ${err.message}`;
    }
}

async function refreshRosterStatus() {
    try {
        const snap = await getDocs(collection(db, 'roster'));
        const rosterStatus = document.getElementById('rosterStatus');
        if (!rosterStatus) return;

        if (!snap.size) {
            rosterStatus.innerHTML = '⚠️ No roster records found.';
            return;
        }

        let active = 0, termed = 0;
        snap.forEach(d => {
            if (String(d.data().status || '').toUpperCase() === 'TERMED') termed++; else active++;
        });
        rosterStatus.innerHTML = `✅ Roster loaded: ${snap.size} agents (${active} active, ${termed} termed).`;
    } catch (err) {
        console.warn("Roster status read restricted or failed:", err);
    }
}

/* ==========================================================================
   UNMATCHED ROW REPORTING
   ========================================================================== */
function renderUnmatchedList(rows) {
    const box = document.getElementById('unmatchedBox');
    const body = document.getElementById('unmatchedList');
    if (!box || !body) return;

    if (!rows || !rows.length) {
        box.style.display = 'none';
        body.innerHTML = '';
        return;
    }

    box.style.display = 'block';
    body.innerHTML = `<div class="file-status" style="margin-bottom:6px;">⚠️ ${rows.length} row(s) are not on the Active or Termed roster:</div>` +
        rows.slice(0, 50).map(r =>
            `<div class="file-status">• ${escapeHtml(r.name || '(no name)')} ${r.id ? '· ID: ' + escapeHtml(r.id) : '(no ID)'}</div>`
        ).join('') +
        (rows.length > 50 ? `<div class="file-status">…and ${rows.length - 50} more.</div>` : '');
}

async function resyncAgentEmails() {
    const statusEl = document.getElementById('resyncStatus');
    if (statusEl) statusEl.textContent = 'Re-syncing agent, email, status, and Team Leader matches...';
    try {
        const rosterSnap = await getDocs(collection(db, 'roster'));
        const byName = {}, byId = {};
        rosterSnap.forEach(d => {
            const x = d.data();
            const item = { email: x.email || '', teamLeader: String(x.teamLeader || '').trim(), status: x.status || '' };
            byName[normalizeName(x.agentName)] = item;
            const id = normalizeEmployeeId(x.agentId);
            if (id) byId[id] = item;
        });
        const dataSnap = await getDocs(collection(db, 'auditData'));
        const docs = dataSnap.docs;
        let matched = 0, unmatchedCount = 0, leaders = 0;
        const unmatchedRows = [];
        const promises = [];
        for (let i = 0; i < docs.length; i += 400) {
            const chunk = docs.slice(i, i + 400);
            const batch = writeBatch(db);
            chunk.forEach(d => {
                const row = d.data();
                const id = normalizeEmployeeId(row['EE number/ID number'] || row['WIN ID'] || row['ID']);
                const match = (id && byId[id]) || byName[normalizeName(row['AGENT/OFFICER NAME'])] || null;
                const email = match ? (match.email || '') : '';
                const agentStatus = match ? (match.status || 'UNKNOWN') : 'UNKNOWN';
                const teamLeader = String(row['TEAM LEADER'] || (match ? match.teamLeader : '') || '').trim();
                if (match) {
                    matched++;
                } else {
                    unmatchedCount++;
                    unmatchedRows.push({ name: row['AGENT/OFFICER NAME'], id, source: 'resync' });
                }
                if (teamLeader) leaders++;
                batch.update(doc(db, 'auditData', d.id), { agentEmailLower: email, 'TEAM LEADER': teamLeader, 'AGENT STATUS': agentStatus });
            });
            promises.push(batch.commit());
        }
        await Promise.all(promises);
        await loadAllAuditData();
        populateDropdownOptions(cachedAuditRows);
        filterData();
        lastUnmatchedRows = unmatchedRows;
        renderUnmatchedList(unmatchedRows);
        if (statusEl) statusEl.textContent = `✅ Re-synced: ${matched} agent matches, ${leaders} rows with Team Leader, ${unmatchedCount} not on the roster.`;
    } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = '⚠️ Re-sync failed: ' + err.message;
    }
}

const SOURCE_FIELD_ALIASES = {
    'Start time': ['Start time', 'START TIME'],
    'Agent Work Setup2': ['Agent Work Setup2', 'Agent Work Setup', 'Work Setup', 'Work Setup2', 'WFH/Onsite'],
    'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?': [
        'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?',
        'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL? - HIDDEN',
        'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL? -HIDDEN'
    ],
    'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER?': [
        'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER?',
        'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER? - HIDDEN',
        'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER? -HIDDEN'
    ],
    'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES': [
        'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES',
        'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES - HIDDEN',
        'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES -HIDDEN'
    ]
};

const SCORE_SOURCE_FIELDS = [
    'IS THIS A POTENTIAL CUSTOMER MISTREAT?',
    'IRRELEVANT SOLUTION', 'INCOMPLETE SOLUTION', 'UNTIMELY SOLUTION ( ZTP)', 'UNCLEAR SOLUTION',
    'Poor Listening Skills?', 'Customer Validation and Empathy Gap?',
    'Did not adjust the tone/pace to match the customer?',
    'Did not adjust to the customers language?',
    'Negative Words, Phrasing and Limitations?',
    'Unfriendly/discourteous/sarcastic?', 'Sounded transactional or robotic?',
    'FAST: Were there other Agent factors observed that affected the customer experience?',
    'DID WE FOLLOW THE CUSTOMER AUTHENTICATION PROCESS?',
    'DID WE FOLLOW THE DATA PRIVACY POLICY?',
    'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?',
    'DID WE FOLLOW THE CSAT/NPS PROCESS?',
    'DID WE FOLLOW THE SYSTEM DOCUMENTATION PROCESS?',
    'DID WE FOLLOW THE SYSTEM TAGGING PROCESS?',
    'DID WE FOLLOW CORRECT GRAMMAR, TECHNICAL WRITING & THE PRESCRIBED LANGUAGE?',
    'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER?',
    'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES'
];

const NEEDED_FIELDS = [
    'ID', 'Start time', 'FORM TYPE', 'BRAND', 'LINE OF BUSINESS', 'AGENT/OFFICER NAME', 'AGENT TENURE',
    'TEAM LEADER', 'CLUSTER', 'WEEKENDING', 'MONTH', 'MISTREAT',
    'RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE', 'OVERALL SCORE',
    'EE number/ID number', 'OVERALL PASSRATE', 'CM', 'PASSRATE CM',
    'RELIABLE: ADDITIONAL COMMENTS', 'PERSONABLE: ADDITIONAL COMMENTS', 'FAST: ADDITIONAL COMMENTS',
    'Agent Work Setup2'
].concat(HIT_PARAMS.map(p => p.col), SCORE_SOURCE_FIELDS);

function sourceCandidates(field) {
    return SOURCE_FIELD_ALIASES[field] || [field];
}

function isExactNoOpportunity(value) {
    return normVal(value) === 'NO OPPORTUNITY';
}

function scoreBinaryNoOpportunity(row, fields) {
    return fields.every(f => isExactNoOpportunity(row[f])) ? 1 : 0;
}

function scoreFast(value) {
    const allowed = new Set([
        'NO OPPORTUNITY',
        'UNTIMELY RESPONSE WITH NEGATIVE CX - WITHIN THRESHOLD',
        'UNTIMELY RESPONSE DUE TO KNOWLEDGE ISSUE/GAP',
        'UNTIMELY RESPONSE DUE TO COMPLEX ISSUES',
        'UNTIMELY RESPONSE DUE TO TOOLS ISSUE'
    ]);
    return allowed.has(normVal(value)) ? 1 : 0;
}

function scoreSafeSecure(row) {
    const fields = [
        'DID WE FOLLOW THE CUSTOMER AUTHENTICATION PROCESS?',
        'DID WE FOLLOW THE DATA PRIVACY POLICY?',
        'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?',
        'DID WE FOLLOW THE CSAT/NPS PROCESS?',
        'DID WE FOLLOW THE SYSTEM DOCUMENTATION PROCESS?',
        'DID WE FOLLOW THE SYSTEM TAGGING PROCESS?',
        'DID WE FOLLOW CORRECT GRAMMAR, TECHNICAL WRITING & THE PRESCRIBED LANGUAGE?',
        'DID THE AGENT OFFER SELF-CARE HELP TO THE CUSTOMER?',
        'DID THE AGENT UPSELL OR CROSS SELL RELEVANT PRODUCTS & SERVICES'
    ];
    const excluded = new Set(['', 'NA', 'N/A', 'N.A.', '-', '--', 'NOT APPLICABLE']);
    const applicable = fields
        .map(f => normVal(row[f]).replace(/\s+/g, ' ').trim())
        .filter(v => !excluded.has(v));
    if (!applicable.length) return 1;
    const isCompliant = v => v === 'YES' || v === 'Y' || v.startsWith('NO OPPORTUNITY');
    return applicable.filter(isCompliant).length / applicable.length;
}

function parseUploadDate(value) {
    if (value instanceof Date && !isNaN(value)) return value;
    if (typeof value === 'number' && isFinite(value)) {
        const parts = XLSX.SSF.parse_date_code(value);
        return parts ? new Date(parts.y, parts.m - 1, parts.d) : null;
    }
    const text = String(value || '').trim();
    if (!text) return null;
    const parsed = new Date(text);
    return isNaN(parsed) ? null : parsed;
}

function deriveWeekendingAndMonth(startValue) {
    const d = parseUploadDate(startValue);
    if (!d) return { weekending: '', month: '' };
    const result = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const mondayBasedDay = (result.getDay() + 6) % 7;
    result.setDate(result.getDate() + (6 - mondayBasedDay));
    const mm = String(result.getMonth() + 1).padStart(2, '0');
    const dd = String(result.getDate()).padStart(2, '0');
    const month = d.toLocaleString('en-US', { month: 'long' }).toUpperCase();
    return { weekending: 'WE' + mm + dd, month };
}

function calculateGenuineCareScores(row) {
    const noMistreat = normVal(row['IS THIS A POTENTIAL CUSTOMER MISTREAT?']) === 'NO';
    const reliableRaw = scoreBinaryNoOpportunity(row, [
        'IRRELEVANT SOLUTION', 'INCOMPLETE SOLUTION', 'UNTIMELY SOLUTION ( ZTP)', 'UNCLEAR SOLUTION'
    ]);
    const personableRaw = scoreBinaryNoOpportunity(row, [
        'Poor Listening Skills?', 'Customer Validation and Empathy Gap?',
        'Did not adjust the tone/pace to match the customer?',
        'Did not adjust to the customers language?', 'Negative Words, Phrasing and Limitations?',
        'Unfriendly/discourteous/sarcastic?', 'Sounded transactional or robotic?'
    ]);
    const reliable = noMistreat && reliableRaw === 1 ? 1 : 0;
    const personable = noMistreat && personableRaw === 1 ? 1 : 0;
    const fast = scoreFast(row['FAST: Were there other Agent factors observed that affected the customer experience?']);
    const safe = noMistreat ? scoreSafeSecure(row) : 0;
    const overall = (reliable * 0.45) + (personable * 0.45) + (fast * 0.05) + (safe * 0.05);
    const overallPct = Math.round(overall * 10000) / 100;
    const cluster = overall >= 0.95 ? 'A' : overall >= 0.90 ? 'B' : overall >= 0.80 ? 'C' : 'D';
    const cm = overall >= 0.95 ? 'SUPERSTAR' : overall >= 0.90 ? 'PERFORMER' : overall >= 0.80 ? 'LAGGARD' : 'UNDERPERFORMER';
    const passrateCm = overall >= 0.90 ? 'SUPERSTAR' : overall >= 0.80 ? 'PERFORMER' : overall >= 0.70 ? 'LAGGARD' : 'UNDERPERFORMER';
    return {
        'MISTREAT': noMistreat ? 100 : 0,
        'RELIABLE': reliable * 100,
        'PERSONABLE': personable * 100,
        'FAST': fast * 100,
        'SAFE & SECURE': Math.round(safe * 10000) / 100,
        'OVERALL SCORE': overallPct,
        'CLUSTER': cluster,
        'CM': cm,
        'PASSRATE CM': passrateCm,
        'OVERALL PASSRATE': overall >= 0.90 ? 'PASSED' : 'FAILED'
    };
}

async function handleDataUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataStatus = document.getElementById('dataStatus');
    if (dataStatus) dataStatus.textContent = 'Processing ' + file.name + '...';
    try {
        const rows = await parseWorkbookFile(file, ['RAW', 'DATA', 'SHEET1']);
        if (!rows.length) throw new Error('Data file appears empty.');
        const headerMap = {};
        NEEDED_FIELDS.forEach(f => {
            const h = findHeader(rows[0], sourceCandidates(f));
            if (h) headerMap[f] = h;
        });
        const required = ['AGENT/OFFICER NAME', 'IS THIS A POTENTIAL CUSTOMER MISTREAT?'];
        const missing = required.filter(f => !headerMap[f]);
        if (missing.length) throw new Error('Missing required raw-data column(s): ' + missing.join(', '));

        const rosterSnap = await getDocs(collection(db, 'roster'));
        const nameToRoster = {}, idToRoster = {};
        rosterSnap.forEach(d => {
            const data = d.data();
            const item = { email: data.email || '', teamLeader: String(data.teamLeader || '').trim(), status: data.status || '' };
            nameToRoster[normalizeName(data.agentName)] = item;
            const rosterId = normalizeEmployeeId(data.agentId);
            if (rosterId) idToRoster[rosterId] = item;
        });
        const UPPERCASE_FIELDS = ['FORM TYPE', 'AGENT TENURE'];
        const TRIM_ONLY_FIELDS = ['BRAND', 'LINE OF BUSINESS', 'TEAM LEADER'];
        let calculatedCount = 0;
        const unmatched = [];
        const processed = rows.map(r => {
            const out = {};
            NEEDED_FIELDS.forEach(f => {
                const h = headerMap[f];
                out[f] = h ? r[h] : '';
            });
            UPPERCASE_FIELDS.forEach(f => { out[f] = normVal(out[f]); });
            TRIM_ONLY_FIELDS.forEach(f => { out[f] = String(out[f] || '').trim(); });

            const derived = calculateGenuineCareScores(out);
            Object.assign(out, derived);
            const period = deriveWeekendingAndMonth(out['Start time']);
            if (period.weekending) out['WEEKENDING'] = period.weekending;
            if (period.month) out['MONTH'] = period.month;
            calculatedCount++;

            const auditId = normalizeEmployeeId(out['EE number/ID number'] || out['WIN ID'] || out['ID']);
            const rosterMatch = (auditId && idToRoster[auditId]) || nameToRoster[normalizeName(out['AGENT/OFFICER NAME'])] || null;
            out.agentEmailLower = rosterMatch ? (rosterMatch.email || '') : '';
            out['AGENT STATUS'] = rosterMatch ? (rosterMatch.status || 'UNKNOWN') : 'UNKNOWN';
            if (!String(out['TEAM LEADER'] || '').trim()) out['TEAM LEADER'] = rosterMatch ? (rosterMatch.teamLeader || '') : '';

            if (!rosterMatch) {
                unmatched.push({ name: out['AGENT/OFFICER NAME'], id: auditId, source: 'upload' });
            }

            return out;
        }).filter(r => String(r['AGENT/OFFICER NAME'] || '').trim());
        await replaceAuditData(processed, (phase, done, total) => {
            if (!dataStatus) return;
            const pct = total ? Math.round(done / total * 100) : 100;
            dataStatus.textContent = `${phase}: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
        });
        cachedAuditRows = processed;
        const safeValues = processed.map(r => r['SAFE & SECURE']).filter(v => v !== null && v !== undefined && !isNaN(v));
        const safeAverage = safeValues.length ? Math.round(safeValues.reduce((a, b) => a + Number(b), 0) / safeValues.length) : 0;
        const leaderRows = processed.filter(r => String(r['TEAM LEADER'] || '').trim()).length;
        const activeRows = processed.filter(r => r['AGENT STATUS'] === 'ACTIVE').length;
        const termedRows = processed.filter(r => r['AGENT STATUS'] === 'TERMED').length;
        if (dataStatus) dataStatus.innerHTML = `✅ Uploaded and fully synchronized ${processed.length} audits. Safe & Secure average: ${safeAverage}%. Team Leader matched: ${leaderRows}/${processed.length}. Roster status: ${activeRows} active, ${termedRows} termed, ${unmatched.length} not on roster. No manual re-sync is required.`;
        lastUnmatchedRows = unmatched;
        renderUnmatchedList(unmatched);
        populateDropdownOptions(processed, true); // auto-select latest weekending after upload
        filterData();
    } catch (err) {
        console.error('Data Upload Failed:', err);
        if (dataStatus) dataStatus.innerHTML = `⚠️ Upload failed: ${escapeHtml(err.message)}`;
    } finally {
        event.target.value = '';
    }
}

/* ==========================================================================
   SUPERVISOR DASHBOARD & FILTERS
   ========================================================================== */
function populateDropdownOptions(rows, autoSelectLatestWeekending = false) {
    const map = {
        selectFormType: 'FORM TYPE',
        selectBrand: 'LINE OF BUSINESS',
        selectMonth: 'MONTH',
        selectWeekending: 'WEEKENDING',
        selectTenure: 'AGENT TENURE',
        selectTeamLeader: 'TEAM LEADER'
    };
    Object.entries(map).forEach(([selId, field]) => {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const current = sel.value;
        const uniques = [...new Set(rows.map(r => r[field] || r['BRAND']).filter(Boolean))].sort();
        sel.innerHTML = `<option value="ALL">(All)</option>` + uniques.map(v => `<option value="${v}">${v}</option>`).join('');
        if (uniques.includes(current)) {
            sel.value = current;
        }
    });

    // Auto-select the latest weekending on first load so the default view
    // matches the Excel dashboard (which always shows the most recent week).
    // Weekending codes are lexicographically sortable (WE0101 < WE0816),
    // so the last item in the sorted list is always the most recent.
    if (autoSelectLatestWeekending) {
        const weEl = document.getElementById('selectWeekending');
        if (weEl && weEl.options.length > 1) {
            const options = Array.from(weEl.options).map(o => o.value).filter(v => v !== 'ALL');
            if (options.length) {
                const latest = options[options.length - 1]; // already sorted ascending
                weEl.value = latest;
            }
        }
    }
}

// Valid LINE OF BUSINESS values that exist in the current raw file.
// Any audit doc whose LOB is not in this set is a ghost row from an older
// upload (e.g. "BOH - Account Management" before it was renamed to
// "BOH - DIS Account Management") and should be purged automatically.
const VALID_LOB_VALUES = new Set([
    'Enterprise Hotline',
    'Enterprise Sana All',
    'Enterprise Email',
    'Enterprise Social Media',
    'BOH - DIS Account Management'
]);

async function purgeStaleAuditRows(allDocs) {
    const stale = allDocs.filter(d => {
        const lob = String(d.data()['LINE OF BUSINESS'] || d.data()['BRAND'] || '').trim();
        return lob && !VALID_LOB_VALUES.has(lob);
    });

    if (!stale.length) return 0;

    console.warn(`Purging ${stale.length} stale audit doc(s) with unrecognised LOB values.`);
    const batches = [];
    let batch = writeBatch(db);
    let count = 0;
    stale.forEach(d => {
        batch.delete(d.ref);
        count++;
        if (count === 400) {
            batches.push(batch);
            batch = writeBatch(db);
            count = 0;
        }
    });
    if (count > 0) batches.push(batch);
    await Promise.all(batches.map(b => b.commit()));
    return stale.length;
}

async function loadAllAuditData() {
    try {
        const snap = await getDocs(collection(db, 'auditData'));

        // Automatically remove ghost rows whose LOB no longer exists in
        // the current dataset (left behind when a previous, larger upload
        // used different LOB labels or had more rows than the current file).
        const purged = await purgeStaleAuditRows(snap.docs);
        if (purged > 0) {
            console.warn(`Auto-purged ${purged} stale row(s). Reloading clean data.`);
            const cleanSnap = await getDocs(collection(db, 'auditData'));
            cachedAuditRows = cleanSnap.docs.map(d => d.data());
        } else {
            cachedAuditRows = snap.docs.map(d => d.data());
        }

        console.log("Firestore auditData query succeeded. Row count:", cachedAuditRows.length);
        return cachedAuditRows;
    } catch (err) {
        console.error("Failed to load /auditData collection:", err);
        return [];
    }
}

function toggleUploadPanel() {
    const panel = document.getElementById('uploadPopover');
    if (panel) panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function resetFilters() {
    ['selectFormType', 'selectBrand', 'selectMonth', 'selectWeekending', 'selectTenure', 'selectTeamLeader', 'selectAgentStatus']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = 'ALL';
        });
    filterData();
}

function filterData() {
    const rows = cachedAuditRows;
    if (!rows || !rows.length) {
        renderSupervisorDashboard([]);
        return;
    }

    const getValue = (id) => {
        const el = document.getElementById(id);
        return el ? el.value : 'ALL';
    };

    const f = {
        formType: getValue('selectFormType'),
        lob: getValue('selectBrand'),
        month: getValue('selectMonth'),
        weekending: getValue('selectWeekending'),
        tenure: getValue('selectTenure'),
        teamLeader: getValue('selectTeamLeader'),
        agentStatus: getValue('selectAgentStatus')
    };

    const filtered = rows.filter(r => {
        const rLob = r['LINE OF BUSINESS'] || r['BRAND'] || '';
        return (f.formType === 'ALL' || r['FORM TYPE'] === f.formType) &&
            (f.lob === 'ALL' || rLob === f.lob) &&
            (f.month === 'ALL' || r['MONTH'] === f.month) &&
            (f.weekending === 'ALL' || r['WEEKENDING'] === f.weekending) &&
            (f.tenure === 'ALL' || r['AGENT TENURE'] === f.tenure) &&
            (f.teamLeader === 'ALL' || r['TEAM LEADER'] === f.teamLeader) &&
            (f.agentStatus === 'ALL' || (r['AGENT STATUS'] || 'UNKNOWN') === f.agentStatus);
    });

    renderSupervisorDashboard(filtered);
}

function tenureBucket(tenureStr) {
    const t = normVal(tenureStr);
    if (t.includes('NCIP')) return 'ncip';
    if (t.includes('NHIP')) return 'nhip';
    if (t.includes('0-30')) return 'd0';
    if (t.includes('31-60')) return 'd31';
    if (t.includes('61-90')) return 'd61';
    if (t.includes('>91') || t.includes('91')) return 'd91';
    return 'other';
}

function renderGroupedBarChart(data) {
    const canvas = document.getElementById('lobChartCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    const groups = {};
    data.forEach(r => {
        const lob = r['LINE OF BUSINESS'] || r['BRAND'] || 'Unspecified';
        if (!groups[lob]) {
            groups[lob] = { reliable: [], personable: [], fast: [], safe: [], overall: [] };
        }
        if (r['RELIABLE'] !== null && !isNaN(r['RELIABLE'])) groups[lob].reliable.push(r['RELIABLE']);
        if (r['PERSONABLE'] !== null && !isNaN(r['PERSONABLE'])) groups[lob].personable.push(r['PERSONABLE']);
        if (r['FAST'] !== null && !isNaN(r['FAST'])) groups[lob].fast.push(r['FAST']);
        if (r['SAFE & SECURE'] !== null && !isNaN(r['SAFE & SECURE'])) groups[lob].safe.push(r['SAFE & SECURE']);
        if (r['OVERALL SCORE'] !== null && !isNaN(r['OVERALL SCORE'])) groups[lob].overall.push(r['OVERALL SCORE']);
    });

    const labels = Object.keys(groups).sort();
    const getAvg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;

    const dataReliable = labels.map(l => getAvg(groups[l].reliable));
    const dataPersonable = labels.map(l => getAvg(groups[l].personable));
    const dataFast = labels.map(l => getAvg(groups[l].fast));
    const dataSafe = labels.map(l => getAvg(groups[l].safe));
    const dataOverall = labels.map(l => getAvg(groups[l].overall));

    if (lobChartInstance) {
        lobChartInstance.destroy();
    }

    lobChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                { label: 'Reliable', data: dataReliable, backgroundColor: '#EF9A9A' },      // Light Rose / Coral
                { label: 'Personable', data: dataPersonable, backgroundColor: '#E57373' },    // Soft Red
                { label: 'Fast', data: dataFast, backgroundColor: '#E53935' },          // Medium Red
                { label: 'Safe & Secure', data: dataSafe, backgroundColor: '#C62828' }, // Crimson / Dark Red
                { label: 'Overall Score', data: dataOverall, backgroundColor: '#7F0000' }   // Deep Burgundy / Wine
            ]
        },
        plugins: [ChartDataLabels],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    top: 20,
                    bottom: 10
                }
            },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'rect',
                        padding: 15,
                        font: { size: 10, weight: 'bold' }
                    }
                },
                datalabels: {
                    anchor: 'end',
                    align: 'top',
                    offset: 2,
                    formatter: (val) => val ? val + '%' : '',
                    font: { size: 8, weight: 'bold' },
                    color: '#333'
                }
            },
            scales: {
                y: {
                    display: false,
                    max: 115
                },
                x: {
                    grid: { display: false },
                    ticks: { 
                        font: { size: 9, weight: '600' }, 
                        color: '#333',
                        maxRotation: 45,
                        minRotation: 0,
                        autoSkip: false
                    }
                }
            }
        }
    });
}

// LOB label → chart series name mapping (matches the Excel dashboard legend)
const LOB_TO_SERIES = {
    'Enterprise Hotline':           'Hotline',
    'Enterprise Sana All':          'Sana All',
    'BOH - DIS Account Management': 'DIS-AM',
    'Enterprise Email':             'Ecare'
    // Enterprise Social Media is intentionally omitted — not in the source chart
};
const SERIES_ORDER  = ['Hotline', 'Sana All', 'DIS-AM', 'Ecare'];
const SERIES_COLORS = {
    Hotline:  '#D8B4F8',   // light purple
    'Sana All': '#C084FC', // medium purple
    'DIS-AM': '#7E22CE',   // dark purple
    Ecare:    '#581C87'    // very dark purple / maroon
};

function renderSiteComparisonChart(data) {
    const canvas = document.getElementById('siteChartCanvas');
    if (!canvas) return;

    // Group data by work setup (site), collapsing WFH/Onsite into WFH
    const siteGroups = {};
    data.forEach(r => {
        let site = String(r['Agent Work Setup2'] || '').trim();
        if (!site) site = 'Unknown';         // blank = no setup recorded
        if (site === 'WFH/Onsite') site = 'On-Site'; // treat hybrid as on-site

        const lob = r['LINE OF BUSINESS'] || '';
        const series = LOB_TO_SERIES[lob];
        if (!series) return;                 // skip unmapped LOBs (e.g. Social Media)

        if (!siteGroups[site]) siteGroups[site] = {};
        if (!siteGroups[site][series]) siteGroups[site][series] = [];

        const score = Number(String(r['OVERALL SCORE'] || '').replace('%', ''));
        if (!isNaN(score)) siteGroups[site][series].push(score);
    });

    const sites = Object.keys(siteGroups).sort(); // e.g. ['On-Site', 'WFH']

    const getAvg = (arr) => arr && arr.length
        ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
        : null;

    const datasets = SERIES_ORDER.map(series => ({
        label: series,
        backgroundColor: SERIES_COLORS[series],
        data: sites.map(site => getAvg((siteGroups[site] || {})[series] || []))
    }));

    if (siteChartInstance) siteChartInstance.destroy();

    siteChartInstance = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: { labels: sites, datasets },
        plugins: [ChartDataLabels],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: { padding: { top: 24, bottom: 10 } },
            plugins: {
                legend: {
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'rect',
                        padding: 14,
                        font: { size: 10, weight: 'bold' }
                    }
                },
                datalabels: {
                    anchor: 'end',
                    align: 'top',
                    offset: 2,
                    formatter: (val) => val != null ? val + '%' : '',
                    font: { size: 8, weight: 'bold' },
                    color: '#333'
                }
            },
            scales: {
                y: { display: false, max: 115 },
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10, weight: '600' }, color: '#333' }
                }
            }
        }
    });
}

function renderSummaryTables(data) {
    const passBody = document.getElementById('passRateSummaryBody');
    const auditBody = document.getElementById('auditCountSummaryBody');
    const avgBody = document.getElementById('averageScoreSummaryBody');

    const COLS = 9; // LOB label + NCIP + NHIP + 0-30 + 31-60 + 61-90 + >91 + Grand Total + pass/fail columns
    if (!data || !data.length) {
        if (passBody) passBody.innerHTML = `<tr><td colspan="4" class="empty-note">Upload data to populate.</td></tr>`;
        if (auditBody) auditBody.innerHTML = `<tr><td colspan="8" class="empty-note">Upload data to populate.</td></tr>`;
        if (avgBody) avgBody.innerHTML = `<tr><td colspan="8" class="empty-note">Upload data to populate.</td></tr>`;
        return;
    }

    // ── helpers ──────────────────────────────────────────────────────────────
    const isPassed = (r) => r['OVERALL PASSRATE'] ? r['OVERALL PASSRATE'] === 'PASSED' : (r['OVERALL SCORE'] || 0) >= 85;
    const BUCKETS = ['ncip', 'nhip', 'd0', 'd31', 'd61', 'd91'];

    function bucketRows(rows) {
        const b = { ncip: [], nhip: [], d0: [], d31: [], d61: [], d91: [] };
        rows.forEach(r => {
            const k = tenureBucket(r['AGENT TENURE']);
            if (b[k]) b[k].push(r); // ignore 'other' — lumped into grand total only
        });
        return b;
    }

    function countCell(arr) { return arr.length > 0 ? arr.length : '-'; }

    function avgScore(arr) {
        const vals = arr.map(r => Number(r['OVERALL SCORE'])).filter(v => !isNaN(v));
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + '%' : '-';
    }

    // Group data by LOB
    const lobMap = {};
    data.forEach(r => {
        const lob = r['LINE OF BUSINESS'] || r['BRAND'] || 'Unspecified';
        if (!lobMap[lob]) lobMap[lob] = [];
        lobMap[lob].push(r);
    });
    const lobs = Object.keys(lobMap).sort();

    // ── Pass Rate % table ─────────────────────────────────────────────────────
    if (passBody) {
        const lobRows = lobs.map(lob => {
            const rows = lobMap[lob];
            const passed = rows.filter(isPassed).length;
            const pct = Math.round(passed / rows.length * 100);
            return `<tr>
                <td style="text-align:left;">${escapeHtml(lob)}</td>
                <td>${pct}%</td>
                <td>${100 - pct}%</td>
                <td>100%</td>
            </tr>`;
        }).join('');

        const totalPassed = data.filter(isPassed).length;
        const totalPct = Math.round(totalPassed / data.length * 100);
        passBody.innerHTML = lobRows + `<tr class="total-row">
            <td style="text-align:left;">Grand Total</td>
            <td>${totalPct}%</td>
            <td>${100 - totalPct}%</td>
            <td>100%</td>
        </tr>`;
    }

    // ── Number of Audits table ────────────────────────────────────────────────
    if (auditBody) {
        const lobRows = lobs.map(lob => {
            const b = bucketRows(lobMap[lob]);
            return `<tr>
                <td style="text-align:left;">${escapeHtml(lob)}</td>
                ${BUCKETS.map(k => `<td>${countCell(b[k])}</td>`).join('')}
                <td>${lobMap[lob].length}</td>
            </tr>`;
        }).join('');

        const totalB = bucketRows(data);
        auditBody.innerHTML = lobRows + `<tr class="total-row">
            <td style="text-align:left;">Grand Total</td>
            ${BUCKETS.map(k => `<td>${countCell(totalB[k])}</td>`).join('')}
            <td>${data.length}</td>
        </tr>`;
    }

    // ── Average OA Scores table ───────────────────────────────────────────────
    if (avgBody) {
        const lobRows = lobs.map(lob => {
            const b = bucketRows(lobMap[lob]);
            return `<tr>
                <td style="text-align:left;">${escapeHtml(lob)}</td>
                ${BUCKETS.map(k => `<td>${avgScore(b[k])}</td>`).join('')}
                <td>${avgScore(lobMap[lob])}</td>
            </tr>`;
        }).join('');

        const totalB = bucketRows(data);
        avgBody.innerHTML = lobRows + `<tr class="total-row">
            <td style="text-align:left;">Grand Total</td>
            ${BUCKETS.map(k => `<td>${avgScore(totalB[k])}</td>`).join('')}
            <td>${avgScore(data)}</td>
        </tr>`;
    }
}

function renderSupervisorDashboard(data) {
    const cmSuperstarVal = document.getElementById('cmSuperstarVal');
    const cmUnderperformerVal = document.getElementById('cmUnderperformerVal');
    const leaderChart = document.getElementById('leaderChart');
    const topHitsTable = document.getElementById('topHitsTable');

    const topHitsBody = topHitsTable ? (topHitsTable.querySelector('tbody') || topHitsTable) : null;

    renderSummaryTables(data);

    if (!data || !data.length) {
        if (cmSuperstarVal) cmSuperstarVal.textContent = '-';
        if (cmUnderperformerVal) cmUnderperformerVal.textContent = '-';
        if (leaderChart) leaderChart.innerHTML = '<div class="empty-note">No matching data.</div>';
        if (topHitsBody) topHitsBody.innerHTML = '<tr><td colspan="3" class="empty-note">No matching audit data available.</td></tr>';
        
        if (lobChartInstance) {
            lobChartInstance.destroy();
            lobChartInstance = null;
        }
        if (siteChartInstance) {
            siteChartInstance.destroy();
            siteChartInstance = null;
        }
        return;
    }

    renderGroupedBarChart(data);
    renderSiteComparisonChart(data);

    const cmRows = data.filter(r => r['CM']);
    if (cmRows.length) {
        const superstar = cmRows.filter(r => r['CM'] === 'SUPERSTAR').length;
        if (cmSuperstarVal) cmSuperstarVal.textContent = Math.round((superstar / cmRows.length) * 100) + '%';
        if (cmUnderperformerVal) cmUnderperformerVal.textContent = Math.round(((cmRows.length - superstar) / cmRows.length) * 100) + '%';
    } else {
        if (cmSuperstarVal) cmSuperstarVal.textContent = '-';
        if (cmUnderperformerVal) cmUnderperformerVal.textContent = '-';
    }

    const tlScores = {};
    data.forEach(r => {
        const tl = r['TEAM LEADER'] || 'Unassigned';
        if (!tlScores[tl]) tlScores[tl] = { total: 0, count: 0 };
        if (r['OVERALL SCORE'] !== null && r['OVERALL SCORE'] !== undefined && !isNaN(r['OVERALL SCORE'])) {
            tlScores[tl].total += r['OVERALL SCORE'];
            tlScores[tl].count++;
        }
    });

    if (leaderChart) {
        leaderChart.innerHTML = Object.entries(tlScores).map(([tl, s]) => {
            const a = s.count ? Math.round(s.total / s.count) : 0;
            return `<div class="horizontal-bar-row">
                <div class="horizontal-label" title="${escapeHtml(tl)}">${escapeHtml(tl)}</div>
                <div class="horizontal-bar-container"><div class="horizontal-bar-fill" style="width:${a}%;">${a}%</div></div>
            </div>`;
        }).join('') || '<div class="empty-note">No matching data.</div>';
    }

    const hitCounts = {};
    data.forEach(r => {
        getRowIssues(r).forEach(issue => {
            const key = issue.label + '||' + issue.category;
            hitCounts[key] = (hitCounts[key] || 0) + 1;
        });
    });
    const sortedHits = Object.entries(hitCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    
    if (topHitsBody) {
        topHitsBody.innerHTML = sortedHits.length
            ? sortedHits.map(([key, count]) => {
                const [label, category] = key.split('||');
                return `<tr><td style="text-align:left;">${escapeHtml(label)}</td><td>${escapeHtml(category)}</td><td>${count}</td></tr>`;
            }).join('')
            : '<tr><td colspan="3" class="empty-note">No parameters flagged in this selection.</td></tr>';
    }
}

/* ==========================================================================
   AGENT DASHBOARD VIEW
   ========================================================================== */
async function renderAgentView() {
    const welcomeName = document.getElementById('agentWelcomeName');
    if (welcomeName) {
        welcomeName.textContent = 'Welcome, ' + (currentSession.agentName || currentSession.email);
    }

    let myRows = [];
    try {
        const q = query(collection(db, 'auditData'), where('agentEmailLower', '==', currentSession.email.toLowerCase()));
        const snap = await getDocs(q);
        myRows = snap.docs.map(d => d.data());
    } catch (err) {
        console.error("Agent query failed:", err);
    }

    const emptyState = document.getElementById('agentEmptyState');
    const agentContent = document.getElementById('agentContent');

    if (!myRows.length) {
        if (emptyState) emptyState.style.display = 'block';
        if (agentContent) agentContent.style.display = 'none';
        return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (agentContent) agentContent.style.display = 'flex';

    const avg = (key) => {
        const vals = myRows.map(r => r[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };

    const tiles = [
        { label: 'Reliable', val: avg('RELIABLE') },
        { label: 'Personable', val: avg('PERSONABLE') },
        { label: 'Fast', val: avg('FAST') },
        { label: 'Safe & Secure', val: avg('SAFE & SECURE') },
        { label: 'Overall Score', val: avg('OVERALL SCORE') }
    ];

    const scorecard = document.getElementById('agentScorecard');
    if (scorecard) {
        scorecard.innerHTML = tiles.map(t =>
            `<div class="score-tile"><div class="num">${t.val === null ? '-' : t.val + '%'}</div><div class="lbl">${t.label}</div></div>`
        ).join('');
    }

    const sorted = [...myRows].sort((a, b) => String(b['WEEKENDING'] || '').localeCompare(String(a['WEEKENDING'] || '')));

    const auditRowHtml = (r) => {
        const issues = getRowIssues(r);
        const score = r['OVERALL SCORE'];
        const passed = r['OVERALL PASSRATE'] ? r['OVERALL PASSRATE'] === 'PASSED' : (score !== null && score >= 85);
        const tagsHtml = issues.length
            ? issues.map(i => `<span class="tag ${i.category.replace(/\s|&/g, '')}">${escapeHtml(i.label)}</span>`).join('')
            : `<span class="no-issues-note">✓ No parameters flagged on this audit.</span>`;

        const comments = ['RELIABLE: ADDITIONAL COMMENTS', 'PERSONABLE: ADDITIONAL COMMENTS', 'FAST: ADDITIONAL COMMENTS']
            .map(f => String(r[f] || '').trim())
            .filter(c => c && !NON_ISSUE_VALUES.has(c.toUpperCase()));
        const commentsHtml = comments.length
            ? `<div class="audit-comments">${comments.map(c => `<p>${escapeHtml(c)}</p>`).join('')}</div>`
            : '';

        return `<div class="audit-row">
            <div class="audit-head">
                <span>${escapeHtml(r['WEEKENDING'])} · ${escapeHtml(r['FORM TYPE'])} · ${escapeHtml(r['LINE OF BUSINESS'] || r['BRAND'])}</span>
                <span class="score-pill ${passed ? 'pass-pill' : 'fail-pill'}">${score === null ? '-' : score + '%'}</span>
            </div>
            <div class="audit-meta">Team Leader: ${escapeHtml(r['TEAM LEADER']) || '—'} · Cluster: ${escapeHtml(r['CLUSTER']) || '—'} · Month: ${escapeHtml(r['MONTH']) || '—'}</div>
            <div>${tagsHtml}</div>
            ${commentsHtml}
        </div>`;
    };

    const groups = {};
    sorted.forEach(r => {
        const m = normVal(r['MONTH']) || 'UNSPECIFIED';
        if (!groups[m]) groups[m] = [];
        groups[m].push(r);
    });

    const orderedMonths = Object.keys(groups).sort((a, b) => {
        const aMax = groups[a].reduce((mx, r) => String(r['WEEKENDING'] || '') > mx ? String(r['WEEKENDING'] || '') : mx, '');
        const bMax = groups[b].reduce((mx, r) => String(r['WEEKENDING'] || '') > mx ? String(r['WEEKENDING'] || '') : mx, '');
        return bMax.localeCompare(aMax);
    });

    const agentAuditList = document.getElementById('agentAuditList');
    if (agentAuditList) {
        agentAuditList.innerHTML = orderedMonths.map((month, idx) => {
            const rows = groups[month];
            const monthAvg = (() => {
                const vals = rows.map(r => r['OVERALL SCORE']).filter(v => v !== null && v !== undefined && !isNaN(v));
                return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
            })();
            return `<details class="month-group" ${idx === 0 ? 'open' : ''}>
                <summary class="month-summary">
                    <span>${month} <span class="month-count">(${rows.length} audit${rows.length === 1 ? '' : 's'})</span></span>
                    <span class="month-avg">${monthAvg === null ? '' : 'avg ' + monthAvg + '%'}</span>
                </summary>
                <div class="month-body">${rows.map(auditRowHtml).join('')}</div>
            </details>`;
        }).join('');
    }
}

/* ==========================================================================
   GLOBAL EXPORTS & INITIALIZATION
   ========================================================================== */
window.switchAuthTab = switchAuthTab;
window.setSignupRole = setSignupRole;
window.handleSignup = handleSignup;
window.handleLogin = handleLogin;
window.quickAccess = quickAccess;
window.logout = logout;
window.filterData = filterData;
window.resetFilters = resetFilters;
window.toggleUploadPanel = toggleUploadPanel;
window.handleRosterUpload = handleRosterUpload;
window.handleDataUpload = handleDataUpload;
window.resyncAgentEmails = resyncAgentEmails;

setSignupRole('agent');
