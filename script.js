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

async function replaceAuditData(rows) {
    const metaRef = doc(db, 'meta', 'auditData');
    const metaSnap = await getDoc(metaRef);
    const prevCount = metaSnap.exists() ? (metaSnap.data().count || 0) : 0;

    const deletePromises = [];
    for (let i = 0; i < prevCount; i += 400) {
        const end = Math.min(i + 400, prevCount);
        const batch = writeBatch(db);
        for (let j = i; j < end; j++) batch.delete(doc(db, 'auditData', 'row_' + j));
        deletePromises.push(batch.commit());
    }
    await Promise.all(deletePromises);

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
let currentSession = null; 
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

            let cred = await createUserWithEmailAndPassword(auth, email, pw);
            await setDoc(doc(db, 'users', cred.user.uid), { email, role: signupRole });
            await signOut(auth);
            showAuthMsg('signupMsg', `${signupRole === 'team_leader' ? 'Team Leader' : 'Quality'} account created. Log in now.`, true);
            clearSignupForm();
            setTimeout(() => switchAuthTab('login'), 1200);
            return;
        }

        let cred = await createUserWithEmailAndPassword(auth, email, pw);
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
        showAuthMsg('signupMsg', friendlyAuthError(err), false);
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
        if (!profileSnap.exists()) return showAuthMsg('loginMsg', 'No user profile found.', false);
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
            return showAuthMsg('loginMsg', 'No user profile found.', false);
        }
        currentSession = { uid: cred.user.uid, ...profileSnap.data() };
        await enterApp();
    } catch (err) {
        showAuthMsg('loginMsg', friendlyAuthError(err), false);
    } finally {
        authFlowInProgress = false;
    }
}

function logout() { signOut(auth); }

function friendlyAuthError(err) {
    const code = err && err.code ? err.code : '';
    if (code.includes('email-already-in-use')) return 'An account with this email already exists.';
    if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'Incorrect email or password.';
    return 'Authentication error: ' + (err && err.message ? err.message : 'Please try again.');
}

function resetToLoggedOutState() {
    currentSession = null;
    cachedAuditRows = [];
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
    document.getElementById('sessionChip').style.display = 'none';
    clearSignupForm();
    switchAuthTab('login');
}

onAuthStateChanged(auth, async (user) => {
    if (authFlowInProgress) return;
    if (!user) { resetToLoggedOutState(); return; }
    try {
        const profileSnap = await getDoc(doc(db, 'users', user.uid));
        if (!profileSnap.exists()) { await signOut(auth); return; }
        currentSession = { uid: user.uid, ...profileSnap.data() };
        await enterApp();
    } catch (err) { console.error(err); }
});

async function enterApp() {
    if (!currentSession) return;
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'flex';
    document.getElementById('sessionChip').style.display = 'flex';

    const normRole = getNormalizedRole(currentSession.role);
    const canViewDashboard = ['quality', 'team_leader', 'supervisor'].includes(normRole);
    const canUpload = ['quality', 'supervisor'].includes(normRole);

    document.getElementById('supervisorSidebar').style.display = canViewDashboard ? 'flex' : 'none';
    document.getElementById('supervisorView').style.display = canViewDashboard ? 'flex' : 'none';
    document.getElementById('agentView').style.display = canViewDashboard ? 'none' : 'flex';
    document.getElementById('uploadIconBtn').style.display = canUpload ? 'flex' : 'none';

    if (canViewDashboard) {
        if (canUpload) await refreshRosterStatus();
        const rows = await loadAllAuditData();
        document.getElementById('dataStatus').innerHTML = rows.length ? `✅ ${rows.length} audit rows loaded.` : `⚠️ 0 rows in database.`;
        populateDropdownOptions(rows);
        filterData();
    } else {
        await renderAgentView();
    }
}

/* ==========================================================================
   ROBUST SCORING & CALCULATION ENGINE
   ========================================================================== */
function parseNumericScore(val) {
    if (val === null || val === undefined) return null;
    let s = String(val).trim();
    if (s === '' || s.toUpperCase() === 'N/A' || s.toUpperCase() === 'NO OPPORTUNITY' || s.toUpperCase() === 'NONE') return null;
    
    s = s.replace('%', '');
    let n = parseFloat(s);
    if (isNaN(n)) return null;

    if (n > 0 && n <= 1.0 && String(val).includes('.')) {
        return Math.round(n * 100);
    }
    if (n >= 0 && n <= 1 && !String(val).includes('.')) {
        return Math.round(n * 100);
    }
    return Math.round(n);
}

function calculateAuditRowScores(row) {
    const categories = ['RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE'];
    let validCategoryScores = [];
    
    categories.forEach(cat => {
        let rawVal = row[cat];
        let parsed = parseNumericScore(rawVal);
        if (parsed !== null) {
            row[cat] = parsed;
            validCategoryScores.push(parsed);
        } else {
            row[cat] = null;
        }
    });

    let existingOverall = parseNumericScore(row['OVERALL SCORE']);
    
    if (existingOverall !== null) {
        row['OVERALL SCORE'] = existingOverall;
    } else if (validCategoryScores.length > 0) {
        let sum = validCategoryScores.reduce((acc, val) => acc + val, 0);
        row['OVERALL SCORE'] = Math.round(sum / validCategoryScores.length);
    } else {
        row['OVERALL SCORE'] = 0;
    }

    let passRateField = normVal(row['OVERALL PASSRATE']);
    if (!passRateField || (passRateField !== 'PASSED' && passRateField !== 'FAILED')) {
        row['OVERALL PASSRATE'] = row['OVERALL SCORE'] >= 85 ? 'PASSED' : 'FAILED';
    }

    return row;
}

/* ==========================================================================
   FILE PARSING & UPLOADS
   ========================================================================== */
function escapeHtml(str) { return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function normVal(v) { return (v === undefined || v === null) ? '' : String(v).trim().toUpperCase(); }
function normalizeName(str) {
    return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[.,'-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseWorkbookFile(file, keywords = []) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb = XLSX.read(data, { type: 'array' });
                let sheetName = wb.SheetNames[0];
                if (keywords.length) {
                    const found = wb.SheetNames.find(n => keywords.some(kw => n.toUpperCase().includes(kw.toUpperCase())));
                    if (found) sheetName = found;
                }
                resolve(XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false }));
            } catch (err) { reject(err); }
        };
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
    return null;
}

async function handleRosterUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const rows = await parseWorkbookFile(file, ['ROSTER', 'MASTER']);
        const roster = rows.map(r => ({
            email: String(r[findHeader(r, ['Domain', 'Email', 'Work Email'])] || '').trim().toLowerCase(),
            agentName: String(r[findHeader(r, ['Agent Name', 'Employee Name', 'Name'])] || '').trim()
        })).filter(r => r.email && r.agentName);
        await clearCollection('roster');
        await batchWriteDocs('roster', roster, r => r.email);
        document.getElementById('rosterStatus').innerHTML = `✅ Roster uploaded: ${roster.length} agents.`;
    } catch (err) {
        document.getElementById('rosterStatus').innerHTML = `⚠️ Roster upload failed: ${err.message}`;
    }
}

async function refreshRosterStatus() {
    const snap = await getDocs(collection(db, 'roster'));
    document.getElementById('rosterStatus').innerHTML = snap.size ? `✅ Roster active: ${snap.size} agents.` : '⚠️ No roster records found.';
}

const NEEDED_FIELDS = [
    'ID', 'FORM TYPE', 'BRAND', 'LINE OF BUSINESS', 'AGENT/OFFICER NAME', 'AGENT TENURE',
    'TEAM LEADER', 'CLUSTER', 'WEEKENDING', 'MONTH', 'WORK SETUP',
    'RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE', 'OVERALL SCORE', 'OVERALL PASSRATE'
];

async function handleDataUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    try {
        const rows = await parseWorkbookFile(file, ['RAW', 'DATA']);
        const headerMap = {};
        NEEDED_FIELDS.forEach(f => { const h = findHeader(rows[0], [f]); if (h) headerMap[f] = h; });

        const rosterSnap = await getDocs(collection(db, 'roster'));
        const nameToEmail = {};
        rosterSnap.forEach(d => { nameToEmail[normalizeName(d.data().agentName)] = d.id; });

        const processed = rows.map(r => {
            const out = {};
            NEEDED_FIELDS.forEach(f => { out[f] = headerMap[f] ? r[headerMap[f]] : ''; });
            
            calculateAuditRowScores(out);

            out['LINE OF BUSINESS'] = out['LINE OF BUSINESS'] || out['BRAND'] || 'Enterprise Hotline';
            out['WORK SETUP'] = (normVal(out['WORK SETUP']).includes('WFH') || normVal(out['WORK SETUP']).includes('HOME')) ? 'WFH' : 'On-Site';
            out.agentEmailLower = nameToEmail[normalizeName(out['AGENT/OFFICER NAME'])] || '';
            return out;
        }).filter(r => r['AGENT/OFFICER NAME']);

        await replaceAuditData(processed);
        cachedAuditRows = processed;
        document.getElementById('dataStatus').innerHTML = `✅ Successfully uploaded and calculated ${processed.length} records.`;
        populateDropdownOptions(processed);
        filterData();
    } catch (err) {
        document.getElementById('dataStatus').innerHTML = `⚠️ Upload failed: ${err.message}`;
    }
}

/* ==========================================================================
   DASHBOARD FILTERING & MULTI-LOB RENDERING
   ========================================================================== */
function populateDropdownOptions(rows) {
    const map = { selectFormType: 'FORM TYPE', selectBrand: 'LINE OF BUSINESS', selectMonth: 'MONTH', selectWeekending: 'WEEKENDING', selectTenure: 'AGENT TENURE', selectTeamLeader: 'TEAM LEADER' };
    Object.entries(map).forEach(([selId, field]) => {
        const sel = document.getElementById(selId);
        if (!sel) return;
        const uniques = [...new Set(rows.map(r => r[field]).filter(Boolean))].sort();
        sel.innerHTML = `<option value="ALL">(All)</option>` + uniques.map(v => `<option value="${v}">${v}</option>`).join('');
    });
}

async function loadAllAuditData() {
    const snap = await getDocs(collection(db, 'auditData'));
    cachedAuditRows = snap.docs.map(d => d.data());
    return cachedAuditRows;
}

function toggleUploadPanel() {
    const p = document.getElementById('uploadPopover');
    p.style.display = p.style.display === 'none' ? 'flex' : 'none';
}

function resetFilters() {
    ['selectFormType', 'selectBrand', 'selectMonth', 'selectWeekending', 'selectTenure', 'selectTeamLeader'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = 'ALL';
    });
    filterData();
}

function filterData() {
    const g = id => document.getElementById(id)?.value || 'ALL';
    const filters = { formType: g('selectFormType'), lob: g('selectBrand'), month: g('selectMonth'), weekending: g('selectWeekending'), tenure: g('selectTenure'), tl: g('selectTeamLeader') };

    const filtered = cachedAuditRows.filter(r => 
        (filters.formType === 'ALL' || r['FORM TYPE'] === filters.formType) &&
        (filters.lob === 'ALL' || r['LINE OF BUSINESS'] === filters.lob) &&
        (filters.month === 'ALL' || r['MONTH'] === filters.month) &&
        (filters.weekending === 'ALL' || r['WEEKENDING'] === filters.weekending) &&
        (filters.tenure === 'ALL' || r['AGENT TENURE'] === filters.tenure) &&
        (filters.tl === 'ALL' || r['TEAM LEADER'] === filters.tl)
    );
    renderSupervisorDashboard(filtered);
}

function tenureGroup(tStr) {
    const t = normVal(tStr);
    if (t.includes('0-30') || t.includes('0 - 30') || t === '0-30') return '0-30';
    if (t.includes('31-60') || t.includes('31 - 60')) return '31-60';
    if (t.includes('61-90') || t.includes('61 - 90')) return '61-90';
    return '>91';
}

function renderSupervisorDashboard(data) {
    const LOB_LIST = ['Enterprise Hotline', 'Enterprise Sana All', 'BOH - DIS Account Management', 'Enterprise Email', 'Enterprise Social Media'];
    
    // 1. Pass Rate Table Body
    const passRateTbody = document.getElementById('passRateTableBody');
    let totalPass = 0, totalAudits = 0;

    passRateTbody.innerHTML = LOB_LIST.map(lob => {
        const lobRows = data.filter(r => r['LINE OF BUSINESS'] === lob);
        const passed = lobRows.filter(r => normVal(r['OVERALL PASSRATE']) === 'PASSED' || (r['OVERALL SCORE'] !== null && r['OVERALL SCORE'] >= 85)).length;
        const failed = lobRows.length - passed;
        totalPass += passed;
        totalAudits += lobRows.length;
        const passPct = lobRows.length ? Math.round((passed / lobRows.length) * 100) + '%' : '0%';
        const failPct = lobRows.length ? Math.round((failed / lobRows.length) * 100) + '%' : '0%';
        return `<tr><td>${lob}</td><td>${passPct}</td><td>${failPct}</td><td>100%</td></tr>`;
    }).join('') + `<tr class="total-row"><td>Grand Total</td><td>${totalAudits ? Math.round((totalPass/totalAudits)*100)+'%' : '0%'}</td><td>${totalAudits ? Math.round(((totalAudits-totalPass)/totalAudits)*100)+'%' : '0%'}</td><td>100%</td></tr>`;

    // 2. Audit Counts & Averages Tables by Tenure
    const auditCountTbody = document.getElementById('auditCountTableBody');
    const avgScoreTbody = document.getElementById('avgScoreTableBody');
    const tenureCols = ['0-30', '31-60', '61-90', '>91'];

    let countTotals = { '0-30':0, '31-60':0, '61-90':0, '>91':0, total: 0 };
    auditCountTbody.innerHTML = LOB_LIST.map(lob => {
        const lobRows = data.filter(r => r['LINE OF BUSINESS'] === lob);
        const counts = {};
        tenureCols.forEach(col => {
            counts[col] = lobRows.filter(r => tenureGroup(r['AGENT TENURE']) === col).length;
            countTotals[col] += counts[col];
        });
        const rowTotal = lobRows.length;
        countTotals.total += rowTotal;
        return `<tr><td>${lob}</td><td>${counts['0-30']}</td><td>${counts['31-60']}</td><td>${counts['61-90']}</td><td>${counts['>91']}</td><td>${rowTotal}</td></tr>`;
    }).join('') + `<tr class="total-row"><td>Grand Total</td><td>${countTotals['0-30']}</td><td>${countTotals['31-60']}</td><td>${countTotals['61-90']}</td><td>${countTotals['>91']}</td><td>${countTotals.total}</td></tr>`;

    avgScoreTbody.innerHTML = LOB_LIST.map(lob => {
        const lobRows = data.filter(r => r['LINE OF BUSINESS'] === lob);
        const avgs = {};
        tenureCols.forEach(col => {
            const match = lobRows.filter(r => tenureGroup(r['AGENT TENURE']) === col && r['OVERALL SCORE'] !== null);
            avgs[col] = match.length ? Math.round(match.reduce((a,b)=>a+b['OVERALL SCORE'],0)/match.length) + '%' : '-';
        });
        const allMatch = lobRows.filter(r => r['OVERALL SCORE'] !== null);
        const rowAvg = allMatch.length ? Math.round(allMatch.reduce((a,b)=>a+b['OVERALL SCORE'],0)/allMatch.length) + '%' : '-';
        return `<tr><td>${lob}</td><td>${avgs['0-30']}</td><td>${avgs['31-60']}</td><td>${avgs['61-90']}</td><td>${avgs['>91']}</td><td>${rowAvg}</td></tr>`;
    }).join('');

    // 3. Team Leader Leaderboard
    const tlScores = {};
    data.forEach(r => {
        const tl = r['TEAM LEADER'] || 'Unassigned';
        if (!tlScores[tl]) tlScores[tl] = { total: 0, count: 0 };
        if (r['OVERALL SCORE'] !== null) { tlScores[tl].total += r['OVERALL SCORE']; tlScores[tl].count++; }
    });
    document.getElementById('leaderChart').innerHTML = Object.entries(tlScores).map(([tl, s]) => {
        const avg = s.count ? Math.round(s.total / s.count) : 0;
        return `<div class="horizontal-bar-row">
            <div class="horizontal-label" title="${escapeHtml(tl)}">${escapeHtml(tl)}</div>
            <div class="horizontal-bar-container"><div class="horizontal-bar-fill" style="width:${avg}%;">${avg}%</div></div>
        </div>`;
    }).join('') || '<div class="empty-note">No matching data.</div>';

    // 4. Charts Initialization
    renderGroupedBarChart(data);
    renderSiteComparisonChart(data);
}

function renderGroupedBarChart(data) {
    const ctx = document.getElementById('lobChartCanvas').getContext('2d');
    const LOB_LIST = ['Enterprise Hotline', 'Enterprise Sana All', 'BOH - DIS Account Management', 'Enterprise Email'];
    
    const getAvg = (lob, key) => {
        const rows = data.filter(r => r['LINE OF BUSINESS'] === lob && r[key] !== null);
        return rows.length ? Math.round(rows.reduce((a,b)=>a+b[key],0)/rows.length) : 0;
    };

    if (lobChartInstance) lobChartInstance.destroy();
    lobChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: LOB_LIST,
            datasets: [
                { label: 'Reliable', data: LOB_LIST.map(l => getAvg(l, 'RELIABLE')), backgroundColor: '#f2a6a6' },
                { label: 'Personable', data: LOB_LIST.map(l => getAvg(l, 'PERSONABLE')), backgroundColor: '#e57373' },
                { label: 'Fast', data: LOB_LIST.map(l => getAvg(l, 'FAST')), backgroundColor: '#d32f2f' },
                { label: 'Safe & Secure', data: LOB_LIST.map(l => getAvg(l, 'SAFE & SECURE')), backgroundColor: '#b71c1c' },
                { label: 'Overall', data: LOB_LIST.map(l => getAvg(l, 'OVERALL SCORE')), backgroundColor: '#7f0000' }
            ]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, max: 100 }
            },
            plugins: { datalabels: { display: false } } 
        }
    });
}

function renderSiteComparisonChart(data) {
    const ctx = document.getElementById('siteChartCanvas').getContext('2d');
    const channels = ['Enterprise Hotline', 'Enterprise Sana All', 'BOH - DIS Account Management', 'Enterprise Email'];
    
    const getSetupAvg = (channel, setup) => {
        const rows = data.filter(r => r['LINE OF BUSINESS'] === channel && r['WORK SETUP'] === setup && r['OVERALL SCORE'] !== null);
        return rows.length ? Math.round(rows.reduce((a,b)=>a+b['OVERALL SCORE'],0)/rows.length) : 0;
    };

    if (siteChartInstance) siteChartInstance.destroy();
    siteChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: channels,
            datasets: [
                { label: 'On-Site', data: channels.map(c => getSetupAvg(c, 'On-Site')), backgroundColor: '#7a0f1e' },
                { label: 'WFH', data: channels.map(c => getSetupAvg(c, 'WFH')), backgroundColor: '#b71c1c' }
            ]
        },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: {
                y: { beginAtZero: true, max: 100 }
            }
        }
    });
}

/* ==========================================================================
   AGENT VIEW & GLOBAL BINDINGS
   ========================================================================== */
async function renderAgentView() {
    document.getElementById('agentWelcomeName').textContent = 'Welcome, ' + (currentSession.agentName || currentSession.email);
    const q = query(collection(db, 'auditData'), where('agentEmailLower', '==', currentSession.email.toLowerCase()));
    const myRows = (await getDocs(q)).docs.map(d => d.data());

    if (!myRows.length) {
        document.getElementById('agentEmptyState').style.display = 'block';
        document.getElementById('agentContent').style.display = 'none';
        return;
    }
    document.getElementById('agentEmptyState').style.display = 'none';
    document.getElementById('agentContent').style.display = 'flex';
    
    const avg = k => {
        const vals = myRows.map(r => r[k]).filter(v => v !== null);
        return vals.length ? Math.round(vals.reduce((a,b)=>a+b,0)/vals.length) + '%' : '-';
    };
    document.getElementById('agentScorecard').innerHTML = ['RELIABLE', 'PERSONABLE', 'FAST', 'SAFE & SECURE', 'OVERALL SCORE'].map(k => 
        `<div class="score-tile"><div class="num">${avg(k)}</div><div class="lbl">${k}</div></div>`
    ).join('');
}

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
setSignupRole('agent');
