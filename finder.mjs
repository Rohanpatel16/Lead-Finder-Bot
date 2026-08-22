import { google } from 'googleapis';
import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONCURRENCY_LIMIT = 10;

// In-memory cache to make repeated domains instant (0ms)
const domainCache = new Map();

// 1. Google Sheets Authentication
async function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// 2. Real-time DNS MX Lookup (With Domain Caching)
async function getDomainMxInfo(domain) {
  const cleanDomain = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();

  if (domainCache.has(cleanDomain)) {
    return domainCache.get(cleanDomain);
  }

  try {
    const mxRecords = await dns.resolveMx(cleanDomain);
    if (!mxRecords || mxRecords.length === 0) {
      const res = { valid: false, domain: cleanDomain, provider: 'No MX', isDead: true };
      domainCache.set(cleanDomain, res);
      return res;
    }

    mxRecords.sort((a, b) => a.priority - b.priority);

    const mxHosts = mxRecords.map(r => (r.exchange || '').toLowerCase()).join(' ');
    let provider = 'Custom Server';
    if (mxHosts.includes('google') || mxHosts.includes('aspmx')) provider = 'Google Workspace';
    else if (mxHosts.includes('outlook') || mxHosts.includes('microsoft')) provider = 'Microsoft 365';
    else if (mxHosts.includes('zoho')) provider = 'Zoho Mail';

    const primaryMx = mxRecords[0]?.exchange || null;
    if (!primaryMx) {
      const res = { valid: false, domain: cleanDomain, provider: 'No MX Host', isDead: true };
      domainCache.set(cleanDomain, res);
      return res;
    }

    const res = { valid: true, domain: cleanDomain, provider, primaryMx, isCatchAll: null, isDead: false };
    domainCache.set(cleanDomain, res);
    return res;
  } catch (e) {
    const res = { valid: false, domain: cleanDomain, provider: 'Dead Domain', isDead: true };
    domainCache.set(cleanDomain, res);
    return res;
  }
}

// 3. Fast RFC-Compliant SMTP Mailbox Probe
function pingSmtpMailbox(email, mxHost, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!mxHost) return resolve({ exists: false, isPolicy: false, error: 'NO_MX_HOST', message: 'No MX host' });

    let isResolved = false;
    let socket;

    const safeResolve = (val) => {
      if (!isResolved) {
        isResolved = true;
        try { socket.destroy(); } catch (e) {}
        resolve(val);
      }
    };

    try {
      const domain = email.split('@')[1];
      socket = net.createConnection(25, mxHost);
      let step = 0;

      socket.setTimeout(timeoutMs);

      socket.on('data', (data) => {
        const response = data.toString();

        if (step === 0 && response.startsWith('220')) {
          socket.write(`HELO ${domain}\r\n`);
          step++;
        } else if (step === 1 && response.startsWith('250')) {
          socket.write('MAIL FROM:<>\r\n');
          step++;
        } else if (step === 2 && response.startsWith('250')) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          step++;
        } else if (step === 3) {
          const code = parseInt(response.slice(0, 3), 10) || 500;
          let exists = false;
          let isPolicy = false;

          if (response.startsWith('250')) {
            exists = true;
          } else if (response.startsWith('541') || response.startsWith('451')) {
            isPolicy = true;
          } else {
            exists = false;
          }

          try { socket.write('QUIT\r\n'); } catch (e) {}
          safeResolve({ exists, isPolicy, code, message: response.trim() });
        }
      });

      socket.on('error', (err) => safeResolve({ exists: false, isPolicy: false, code: null, error: err.code || 'SOCKET_ERROR', message: err.message }));
      socket.on('timeout', () => safeResolve({ exists: false, isPolicy: false, code: 408, error: 'TIMEOUT', message: 'Connection timed out' }));
      socket.on('close', () => safeResolve({ exists: false, isPolicy: false, code: null, error: 'SOCKET_CLOSED', message: 'Socket connection closed' }));
    } catch (err) {
      safeResolve({ exists: false, isPolicy: false, code: 500, error: err.message, message: err.message });
    }
  });
}

// 4. Fast-Fail Pre-Flight & Catch-All Detection
async function checkDomainHealth(mxInfo) {
  if (mxInfo.isDead) return { isReachable: false, isCatchAll: false };
  if (mxInfo.isCatchAll !== null) return { isReachable: true, isCatchAll: mxInfo.isCatchAll };

  try {
    // ⚡ Fast 1.5s probe to check if server is alive
    const fakeEmail = `chk_${Math.random().toString(36).substring(7)}@${mxInfo.domain}`;
    const probe = await pingSmtpMailbox(fakeEmail, mxInfo.primaryMx, 2000);

    // If server times out on the test address, the entire domain is firewalled/dead
    if (probe.error === 'TIMEOUT') {
      mxInfo.isDead = true;
      mxInfo.isCatchAll = false;
      domainCache.set(mxInfo.domain, mxInfo);
      return { isReachable: false, isCatchAll: false };
    }

    const isCatchAll = (probe.exists === true && probe.code === 250);
    mxInfo.isCatchAll = isCatchAll;
    domainCache.set(mxInfo.domain, mxInfo);
    return { isReachable: true, isCatchAll };
  } catch (e) {
    mxInfo.isDead = true;
    return { isReachable: false, isCatchAll: false };
  }
}

// 5. Complete 15-Permutation Generator
function generateAll15Permutations(fullName, domain) {
  const nameParts = fullName.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const first = nameParts[0] || '';
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  if (!first) return [];
  if (!last) return [`${first}@${domain}`, `contact@${domain}`];

  const f = first[0];
  const l = last[0];

  const permutations = [
    `${first}.${last}@${domain}`,
    `${first}@${domain}`,
    `${f}${last}@${domain}`,
    `${f}.${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${first}${l}@${domain}`,
    `${first}.${l}@${domain}`,
    `${last}@${domain}`,
    `${last}.${first}@${domain}`,
    `${last}${first}@${domain}`,
    `${l}${first}@${domain}`,
    `${l}.${first}@${domain}`,
    `${last}${f}@${domain}`,
    `${last}.${f}@${domain}`,
    `${f}${l}@${domain}`
  ];

  return [...new Set(permutations)];
}

// ============================================================================
// 🚀 CONCURRENT LEAD PROCESSOR (WITH DOMAIN FAST-FAIL)
// ============================================================================
async function processSingleLead(leadItem) {
  const { fullName, companyName, rawDomain, location } = leadItem;
  const nowTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

  try {
    const mxInfo = await getDomainMxInfo(rawDomain);
    if (!mxInfo.valid) {
      console.log(`❌ [DEAD DOMAIN]: "${rawDomain}" (${mxInfo.provider})`);
      return {
        status: 'INVALID DOMAIN',
        foundEmail: '',
        provider: mxInfo.provider,
        nowTime,
        leadForDetails: null,
      };
    }

    const permutations = generateAll15Permutations(fullName, mxInfo.domain);
    
    // ⚡ Fast-Fail Check: Test if domain is reachable in 1.5s
    const { isReachable, isCatchAll } = await checkDomainHealth(mxInfo);

    if (!isReachable) {
      console.log(`⚡ [FAST-FAIL]: Server for "${mxInfo.domain}" is firewalled / timed out. Skipped in 1.5s.`);
      return {
        status: 'USER_NOT_FOUND',
        foundEmail: permutations[0] || '',
        provider: `${mxInfo.provider} (Unreachable)`,
        nowTime,
        leadForDetails: null,
      };
    }

    if (isCatchAll) {
      const bestEmail = permutations[0];
      console.log(`⚠️ [CATCH-ALL]: "${mxInfo.domain}" -> Auto-assigned pattern: ${bestEmail}`);
      return {
        status: 'CATCH_ALL',
        foundEmail: bestEmail,
        provider: `${mxInfo.provider} (Catch-All)`,
        nowTime,
        leadForDetails: [fullName, bestEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    }

    // Precise Server: Probe permutations
    let verifiedEmail = null;
    let finalStatus = 'USER_NOT_FOUND';

    for (let p = 0; p < permutations.length; p++) {
      const candidateEmail = permutations[p];
      const probe = await pingSmtpMailbox(candidateEmail, mxInfo.primaryMx, 2500);

      if (probe.exists && probe.code === 250) {
        console.log(`  ✅ Pattern #${p + 1} (${candidateEmail}) [250 OK] -> "${fullName}"`);
        verifiedEmail = candidateEmail;
        finalStatus = 'VERIFIED';
        break;
      } else if (probe.isPolicy) {
        console.log(`  🛡️ Pattern #${p + 1} (${candidateEmail}) [POLICY ACCEPTED] -> "${fullName}"`);
        verifiedEmail = candidateEmail;
        finalStatus = 'VERIFIED';
        break;
      } else if (probe.code === 550) {
        // Fast skip
        continue;
      } else if (probe.error === 'TIMEOUT') {
        // If candidate times out, break early for this person
        break;
      }
    }

    if (verifiedEmail) {
      console.log(`🎉 [SUCCESS]: ${fullName} -> ${verifiedEmail}`);
      return {
        status: finalStatus,
        foundEmail: verifiedEmail,
        provider: `${mxInfo.provider} (Precise)`,
        nowTime,
        leadForDetails: [fullName, verifiedEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    } else {
      console.log(`🚫 [FAILED]: No mailbox match for ${fullName} at ${rawDomain}`);
      return {
        status: 'USER_NOT_FOUND',
        foundEmail: permutations[0] || '',
        provider: mxInfo.provider,
        nowTime,
        leadForDetails: null,
      };
    }
  } catch (err) {
    console.error(`💥 [ERROR on ${fullName}]:`, err.message);
    return {
      status: 'ERROR',
      foundEmail: '',
      provider: err.message,
      nowTime,
      leadForDetails: null,
    };
  }
}

// ============================================================================
// 🚀 MAIN ENGINE
// ============================================================================
async function runEmailFinder() {
  const startTime = Date.now();
  console.log('⚡ Starting High-Speed 15-Pattern Lead Finder (With Fast-Fail Technology)...');
  const sheets = await getSheets();

  // Load Lead_Finder rows
  const finderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'🎯 Lead_Finder'!A:Z",
  });
  const [fHeaders, ...fRows] = finderRes.data.values || [];
  if (!fHeaders || fRows.length === 0) {
    console.log('No rows found in 🎯 Lead_Finder.');
    return;
  }
  const fCol = Object.fromEntries(fHeaders.map((h, i) => [h.trim(), i]));

  // Load Details rows
  const detailsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Details'!A:Z",
  });
  const [dHeaders, ...dRows] = detailsRes.data.values || [];
  const existingEmails = new Set(dRows.map(r => (r[1] || '').trim().toLowerCase()));

  const pendingLeads = [];
  for (let i = 0; i < fRows.length; i++) {
    const row = fRows[i];
    const fullName = (row[fCol['full_name']] || '').trim();
    const companyName = (row[fCol['company_name']] || '').trim();
    const rawDomain = (row[fCol['company_domain']] || '').trim();
    const location = (row[fCol['location']] || 'your city').trim();
    const status = (row[fCol['Status']] || '').trim().toUpperCase();

    if (
      status === 'VERIFIED' ||
      status === 'CATCH_ALL' ||
      status === 'INVALID DOMAIN' ||
      status === 'USER_NOT_FOUND' ||
      !rawDomain ||
      !fullName
    ) {
      continue;
    }

    pendingLeads.push({
      rowIndex: i,
      rowNum: i + 2,
      row,
      fullName,
      companyName,
      rawDomain,
      location,
    });
  }

  console.log(`📋 Processing ${pendingLeads.length} leads (Parallel Concurrency: ${CONCURRENCY_LIMIT})...\n`);

  const newDetailsRows = [];
  let foundCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < pendingLeads.length; i += CONCURRENCY_LIMIT) {
    const chunk = pendingLeads.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.all(chunk.map(lead => processSingleLead(lead)));

    for (let j = 0; j < chunk.length; j++) {
      const lead = chunk[j];
      const res = results[j];

      fRows[lead.rowIndex][fCol['Status']] = res.status;
      fRows[lead.rowIndex][fCol['Found Email']] = res.foundEmail;
      fRows[lead.rowIndex][fCol['Mail Provider']] = res.provider;
      fRows[lead.rowIndex][fCol['Processed Time']] = res.nowTime;

      if (res.status === 'VERIFIED' || res.status === 'CATCH_ALL') {
        foundCount++;
        if (res.leadForDetails && !existingEmails.has(res.foundEmail.toLowerCase())) {
          existingEmails.add(res.foundEmail.toLowerCase());
          newDetailsRows.push(res.leadForDetails);
        }
      } else {
        invalidCount++;
      }
    }

    // Write chunk updates to sheet
    const firstRowNum = chunk[0].rowNum;
    const lastRowNum = chunk[chunk.length - 1].rowNum;
    const updatedChunkValues = chunk.map(c => fRows[c.rowIndex]);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'🎯 Lead_Finder'!A${firstRowNum}:H${lastRowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: updatedChunkValues },
    });
  }

  if (newDetailsRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Details'!A:L",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newDetailsRows },
    });
    console.log(`\n🚀 Appended ${newDetailsRows.length} verified leads to "Details" tab.`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🏁 Completed in ${durationSec}s! Total Verified/Catch-All: ${foundCount}, Rejected/Invalid: ${invalidCount}`);
}

runEmailFinder().catch(console.error);
