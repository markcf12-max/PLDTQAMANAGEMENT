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

async function replaceAuditData(rows) {
    const metaRef = doc(db, 'meta', 'auditData');
    const metaSnap = await getDoc(metaRef);
    const prevCount = metaSnap.exists() ? (metaSnap.data().count || 0) : 0;

    // Concurrent Deletion
    const deletePromises = [];
    for (let i = 0; i < prevCount; i += 400) {
        const end = Math.min(i + 400, prevCount);
        const batch = writeBatch(db);
        for (let j = i; j < end; j++) batch.delete(doc(db, 'auditData', 'row_' + j));
        deletePromises.push(batch.commit());
    }
    await Promise.all(deletePromises);

    // Concurrent Insertion
    const setPromises = [];
    for (let i = 0; i < rows.length; i += 400) {
        const chunk = rows.slice(i, i + 400);
        const batch = writeBatch(db);
        chunk.forEach((row, idx) => batch.set(doc(db, 'auditData', 'row_' + (i + idx)), row));
        setPromises.push(batch.commit());
    }
    await Promise.all(setPromises);

    await setDoc(metaRef, { count: rows.length, updatedAt: Date.now() });
}

/* ==========================================================================
   SESSION & STATE
   ========================================================================== */
let currentSession = null; // { uid, email, role, agentName, agentId }
let cachedAuditRows = [];

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
        
        populateDropdownOptions(rows);
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
    { col: 'DID WE FOLLOW THE CUSTOMER AUTHENTICATION PROCESS?', category: 'Safe & Secure', label: 'Customer authentication process missed', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE FOLLOW THE DATA PRIVACY POLICY?', category: 'Safe & Secure', label: 'Data privacy policy not followed', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE UPDATE THE CUSTOMER INFORMATION IN THE TOOL?', category: 'Safe & Secure', label: 'Customer info not updated in tool', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE FOLLOW THE CSAT/NPS PROCESS?', category: 'Safe & Secure', label: 'CSAT/NPS process not followed', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE FOLLOW THE SYSTEM DOCUMENTATION PROCESS?', category: 'Safe & Secure', label: 'System documentation process missed', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE FOLLOW THE SYSTEM TAGGING PROCESS?', category: 'Safe & Secure', label: 'System tagging process missed', type: 'boolean', hitValue: 'NO' },
    { col: 'DID WE FOLLOW CORRECT GRAMMAR, TECHNICAL WRITING & THE PRESCRIBED LANGUAGE?', category: 'Safe & Secure', label: 'Grammar / prescribed language standard missed', type: 'boolean', hitValue: 'NO' },
    { col: "IS THIS A POTENTIAL CUSTOMER MISTREAT?", category: 'Mistreat', label: 'Potential customer mistreat flagged', type: 'boolean', hitValue: 'YES' }
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
function parseWorkbookFile(file, preferSheetKeywords = []) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb = XLSX.read(data, { type: 'array' });
                let sheetName = wb.SheetNames[0];

                if (preferSheetKeywords && preferSheetKeywords.length > 0) {
                    const keywords = Array.isArray(preferSheetKeywords) ? preferSheetKeywords : [preferSheetKeywords];
                    const found = wb.SheetNames.find(n => 
                        keywords.some(kw => n.toUpperCase().includes(kw.toUpperCase()))
                    );
                    if (found) sheetName = found;
                }

                const ws = wb.Sheets[sheetName];
                const json = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
                resolve(json);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
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

/* ==========================================================================
   DATA UPLOADS & RESYNC
   ========================================================================== */
async function handleRosterUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const rosterStatus = document.getElementById('rosterStatus');
    if (rosterStatus) rosterStatus.textContent = 'Processing ' + file.name + '...';

    try {
        const rows = await parseWorkbookFile(file, ['ROSTER', 'DOMAIN', 'MASTER']);
        if (!rows.length) throw new Error('Excel file appears empty.');

        const emailKey = findHeader(rows[0], ['PLDT/SMART Domain v2', 'PLDT/SMART Domain', 'Domain', 'Email', 'Work Email', 'Conduent Email Address', 'Email Address']);
        const nameKey = findHeader(rows[0], ['Employee Name', 'Agent Name', 'AGENT/OFFICER NAME', 'Name', 'Full Name']);
        const idKey = findHeader(rows[0], ['Win ID', 'WIN ID', 'ID', 'Employee ID', 'Agent ID']);

        if (!emailKey || !nameKey) {
            throw new Error('Missing required Roster headers (Domain/Email and Agent Name).');
        }

        const roster = rows
            .map(r => ({
                email: String(r[emailKey] || '').trim().toLowerCase(),
                agentName: String(r[nameKey] || '').trim(),
                agentId: idKey ? String(r[idKey] || '').trim() : ''
            }))
            .filter(r => r.email && r.agentName);

        await clearCollection('roster');
        await batchWriteDocs('roster', roster, (r) => r.email);

        if (rosterStatus) rosterStatus.innerHTML = `✅ Roster uploaded: ${roster.length} agent records.`;
    } catch (err) {
        console.error(err);
        if (rosterStatus) rosterStatus.innerHTML = `⚠️ Roster upload failed: ${err.message}`;
    }
}

async function refreshRosterStatus() {
    try {
        const snap = await getDocs(collection(db, 'roster'));
        const rosterStatus = document.getElementById('rosterStatus');
        if (rosterStatus) {
            rosterStatus.innerHTML = snap.size ? `✅ Roster active: ${snap.size} agents.` : '⚠️ No roster records found.';
        }
    } catch (err) {
        console.warn("Roster status read restricted or failed:", err);
    }
}

async function resyncAgentEmails() {
    const statusEl = document.getElementById('resyncStatus');
    if (statusEl) statusEl.textContent = 'Re-syncing email matches...';

    try {
        const rosterSnap = await getDocs(collection(db, 'roster'));
        const nameToEmail = {};
        rosterSnap.forEach(d => {
            const data = d.data();
            nameToEmail[normalizeName(data.agentName)] = d.id;
        });

        const dataSnap = await getDocs(collection(db, 'auditData'));
        const docs = dataSnap.docs;

        let matched = 0, unmatched = 0;
        const promises = [];

        for (let i = 0; i < docs.length; i += 400) {
            const chunk = docs.slice(i, i + 400);
            const batch = writeBatch(db);
            chunk.forEach(d => {
                const row = d.data();
                const key = normalizeName(row['AGENT/OFFICER NAME']);
                const email = nameToEmail[key] || '';
                if (email) matched++; else unmatched++;
                batch.update(doc(db, 'auditData', d.id), { agentEmailLower: email });
            });
            promises.push(batch.commit());
        }
        await Promise.all(promises);

        if (statusEl) statusEl.textContent = `✅ Re-synced: ${matched} records matched to email, ${unmatched} unmatched.`;
    } catch (err) {
        console.error(err);
        if (statusEl) statusEl.textContent = '⚠️ Re-sync failed: ' + err.message;
    }
}

const NEEDED_FIELDS = [
    'ID', 'FORM TYPE', 'BRAND', 'LINE OF BUSINESS', 'AGENT/OFFICER NAME', 'AGENT TENURE',
    'TEAM LEADER', 'CLUSTER', 'WEEKENDING', 'MONTH', 'MISTREAT',
    'RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE', 'OVERALL SCORE',
    'EE number/ID number', 'OVERALL PASSRATE', 'CM',
    'RELIABLE: ADDITIONAL COMMENTS', 'PERSONABLE: ADDITIONAL COMMENTS', 'FAST: ADDITIONAL COMMENTS'
].concat(HIT_PARAMS.map(p => p.col));

async function handleDataUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const dataStatus = document.getElementById('dataStatus');
    if (dataStatus) dataStatus.textContent = 'Processing ' + file.name + '...';

    try {
        const rows = await parseWorkbookFile(file, ['RAW', 'DATA']);
        if (!rows.length) throw new Error('Data file appears empty.');

        const headerMap = {};
        NEEDED_FIELDS.forEach(f => {
            const h = findHeader(rows[0], [f]);
            if (h) headerMap[f] = h;
        });

        const rosterSnap = await getDocs(collection(db, 'roster'));
        const nameToEmail = {};
        rosterSnap.forEach(d => {
            const data = d.data();
            nameToEmail[normalizeName(data.agentName)] = d.id;
        });

        const UPPERCASE_FIELDS = ['FORM TYPE', 'MONTH', 'AGENT TENURE', 'OVERALL PASSRATE', 'CM'];
        const TRIM_ONLY_FIELDS = ['BRAND', 'LINE OF BUSINESS', 'TEAM LEADER', 'CLUSTER', 'WEEKENDING'];

        const processed = rows.map(r => {
            const out = {};
            NEEDED_FIELDS.forEach(f => {
                const h = headerMap[f];
                out[f] = h ? r[h] : '';
            });
            UPPERCASE_FIELDS.forEach(f => { out[f] = normVal(out[f]); });
            TRIM_ONLY_FIELDS.forEach(f => { out[f] = String(out[f] || '').trim(); });

            ['RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE', 'OVERALL SCORE'].forEach(k => {
                const n = parseFloat(out[k]);
                out[k] = isNaN(n) ? null : (n <= 1 ? Math.round(n * 100) : Math.round(n));
            });
            out.agentEmailLower = nameToEmail[normalizeName(out['AGENT/OFFICER NAME'])] || '';
            return out;
        }).filter(r => r['AGENT/OFFICER NAME']);

        await replaceAuditData(processed);

        cachedAuditRows = processed;
        if (dataStatus) dataStatus.innerHTML = `✅ Successfully uploaded ${processed.length} audit records.`;
        
        populateDropdownOptions(processed);
        filterData();
    } catch (err) {
        console.error("Data Upload Failed:", err);
        if (dataStatus) dataStatus.innerHTML = `⚠️ Upload failed: ${err.message}`;
    }
}

/* ==========================================================================
   SUPERVISOR DASHBOARD & FILTERS
   ========================================================================== */
function populateDropdownOptions(rows) {
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
        if (uniques.includes(current)) sel.value = current;
    });
}

async function loadAllAuditData() {
    try {
        const snap = await getDocs(collection(db, 'auditData'));
        cachedAuditRows = snap.docs.map(d => d.data());
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
    ['selectFormType', 'selectBrand', 'selectMonth', 'selectWeekending', 'selectTenure', 'selectTeamLeader']
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
        teamLeader: getValue('selectTeamLeader')
    };

    const filtered = rows.filter(r => {
        const rLob = r['LINE OF BUSINESS'] || r['BRAND'] || '';
        return (f.formType === 'ALL' || r['FORM TYPE'] === f.formType) &&
            (f.lob === 'ALL' || rLob === f.lob) &&
            (f.month === 'ALL' || r['MONTH'] === f.month) &&
            (f.weekending === 'ALL' || r['WEEKENDING'] === f.weekending) &&
            (f.tenure === 'ALL' || r['AGENT TENURE'] === f.tenure) &&
            (f.teamLeader === 'ALL' || r['TEAM LEADER'] === f.teamLeader);
    });

    renderSupervisorDashboard(filtered);
}

function tenureBucket(tenureStr) {
    const t = normVal(tenureStr);
    if (t.includes('0-30')) return 'b1';
    if (t.includes('31-60') || t.includes('61-90') || t.includes('31-90')) return 'b2';
    return 'b3';
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

function renderSupervisorDashboard(data) {
    const totalPassRateVal = document.getElementById('totalPassRateVal');
    const totalFailRateVal = document.getElementById('totalFailRateVal');
    const cmSuperstarVal = document.getElementById('cmSuperstarVal');
    const cmUnderperformerVal = document.getElementById('cmUnderperformerVal');
    const leaderChart = document.getElementById('leaderChart');
    const topHitsTable = document.getElementById('topHitsTable');

    const topHitsBody = topHitsTable ? (topHitsTable.querySelector('tbody') || topHitsTable) : null;

    if (!data || !data.length) {
        if (totalPassRateVal) totalPassRateVal.textContent = '-';
        if (totalFailRateVal) totalFailRateVal.textContent = '-';
        if (cmSuperstarVal) cmSuperstarVal.textContent = '-';
        if (cmUnderperformerVal) cmUnderperformerVal.textContent = '-';
        if (leaderChart) leaderChart.innerHTML = '<div class="empty-note">No matching data.</div>';
        if (topHitsBody) topHitsBody.innerHTML = '<tr><td colspan="3" class="empty-note">No matching audit data available.</td></tr>';
        
        if (lobChartInstance) {
            lobChartInstance.destroy();
            lobChartInstance = null;
        }
        return;
    }

    renderGroupedBarChart(data);

    const avg = (key) => {
        const vals = data.map(r => r[key]).filter(v => v !== null && v !== undefined && !isNaN(v));
        if (!vals.length) return null;
        return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    };

    const avgOverall = avg('OVERALL SCORE');

    const isPassed = (r) => r['OVERALL PASSRATE'] ? r['OVERALL PASSRATE'] === 'PASSED' : (r['OVERALL SCORE'] || 0) >= 85;
    const passed = data.filter(isPassed).length;
    const passPct = Math.round((passed / data.length) * 100);

    if (totalPassRateVal) totalPassRateVal.textContent = passPct + '%';
    if (totalFailRateVal) totalFailRateVal.textContent = (100 - passPct) + '%';

    const buckets = { b1: [], b2: [], b3: [] };
    data.forEach(r => buckets[tenureBucket(r['AGENT TENURE'])].push(r));
    const bucketAvg = (arr) => {
        const vals = arr.map(r => r['OVERALL SCORE']).filter(v => v !== null && v !== undefined && !isNaN(v));
        return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) + '%' : '-';
    };

    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('totalAuditNhip', buckets.b1.length || '-');
    setText('totalAudit31', buckets.b2.length || '-');
    setText('totalAudit91', buckets.b3.length || '-');
    setText('totalAuditTotal', data.length);
    setText('totalAvgNhip', bucketAvg(buckets.b1));
    setText('totalAvg31', bucketAvg(buckets.b2));
    setText('totalAvg91', bucketAvg(buckets.b3));
    setText('totalAvgTotal', avgOverall === null ? '-' : avgOverall + '%');

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
