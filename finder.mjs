import { google } from 'googleapis';
import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONCURRENCY_LIMIT = 5; // Processes 5 leads concurrently for high speed

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
      const res = { valid: false, domain: cleanDomain, provider: 'No MX' };
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
      const res = { valid: false, domain: cleanDomain, provider: 'No MX Host' };
      domainCache.set(cleanDomain, res);
      return res;
    }

    const res = { valid: true, domain: cleanDomain, provider, primaryMx, isCatchAll: null };
    domainCache.set(cleanDomain, res);
    return res;
  } catch (e) {
    const res = { valid: false, domain: cleanDomain, provider: 'Dead Domain' };
    domainCache.set(cleanDomain, res);
    return res;
  }
}

// 3. Fast RFC-Compliant SMTP Mailbox Probe (3.5s Timeout)
function pingSmtpMailbox(email, mxHost) {
  return new Promise((resolve) => {
    if (!mxHost) return resolve({ exists: false, isPolicy: false, error: 'NO_MX_HOST' });

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

      socket.setTimeout(3500); // 3.5s timeout for high speed

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

      socket.on('error', (err) => safeResolve({ exists: false, isPolicy: false, error: err.code || 'SOCKET_ERROR' }));
      socket.on('timeout', () => safeResolve({ exists: false, isPolicy: false, error: 'TIMEOUT' }));
      socket.on('close', () => safeResolve({ exists: false, isPolicy: false, error: 'SOCKET_CLOSED' }));
    } catch (err) {
      safeResolve({ exists: false, isPolicy: false, error: err.message });
    }
  });
}

// 4. Cached Catch-All Domain Detection
async function checkCatchAll(mxInfo) {
  if (mxInfo.isCatchAll !== null) return mxInfo.isCatchAll;

  try {
    const fakeEmail = `chk_${Math.random().toString(36).substring(7)}@${mxInfo.domain}`;
    const probe = await pingSmtpMailbox(fakeEmail, mxInfo.primaryMx);
    const isCatchAll = (probe.exists === true && probe.code === 250);
    mxInfo.isCatchAll = isCatchAll;
    domainCache.set(mxInfo.domain, mxInfo);
    return isCatchAll;
  } catch (e) {
    mxInfo.isCatchAll = false;
    return false;
  }
}

// 5. Complete 15-Permutation Generator (Ordered by Likelihood)
function generateAll15Permutations(fullName, domain) {
  const nameParts = fullName.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const first = nameParts[0] || '';
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  if (!first) return [];
  if (!last) return [`${first}@${domain}`, `contact@${domain}`];

  const f = first[0];
  const l = last[0];

  const permutations = [
    // Tier 1: Top 3 Standard Patterns (Matches ~85% of corporate emails)
    `${first}.${last}@${domain}`,  // 1. first.last@
    `${first}@${domain}`,         // 2. first@
    `${f}${last}@${domain}`,       // 3. flast@

    // Tier 2: Common Secondary Patterns
    `${f}.${last}@${domain}`,      // 4. f.last@
    `${first}${last}@${domain}`,   // 5. firstlast@
    `${first}${l}@${domain}`,      // 6. firstl@
    `${first}.${l}@${domain}`,     // 7. first.l@
    `${last}@${domain}`,           // 8. last@

    // Tier 3: Reverse & Deep Sweep Patterns
    `${last}.${first}@${domain}`,  // 9. last.first@
    `${last}${first}@${domain}`,   // 10. lastfirst@
    `${l}${first}@${domain}`,      // 11. lfirst@
    `${l}.${first}@${domain}`,     // 12. l.first@
    `${last}${f}@${domain}`,       // 13. lastf@
    `${last}.${f}@${domain}`,      // 14. last.f@
    `${f}${l}@${domain}`           // 15. fl@
  ];

  // Return unique list only
  return [...new Set(permutations)];
}

// ============================================================================
// 🚀 CONCURRENT LEAD PROCESSOR
// ============================================================================
async function processSingleLead(leadItem) {
  const { fullName, companyName, rawDomain, location } = leadItem;
  const nowTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

  try {
    const mxInfo = await getDomainMxInfo(rawDomain);
    if (!mxInfo.valid) {
      return {
        status: 'INVALID DOMAIN',
        foundEmail: '',
        provider: mxInfo.provider,
        nowTime,
        leadForDetails: null,
      };
    }

    const permutations = generateAll15Permutations(fullName, mxInfo.domain);
    const isCatchAll = await checkCatchAll(mxInfo);

    // ⚡ Fast Path: If Catch-All, pick the #1 pattern instantly without testing all 15!
    if (isCatchAll) {
      const bestEmail = permutations[0];
      return {
        status: 'CATCH_ALL',
        foundEmail: bestEmail,
        provider: `${mxInfo.provider} (Catch-All)`,
        nowTime,
        leadForDetails: [fullName, bestEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    }

    // 🎯 Precise Domain: Probe permutations sequentially until a match is found
    let verifiedEmail = null;
    let finalStatus = 'USER_NOT_FOUND';

    for (let p = 0; p < permutations.length; p++) {
      const candidateEmail = permutations[p];
      const probe = await pingSmtpMailbox(candidateEmail, mxInfo.primaryMx);

      // 🛑 Early Exit: If verified, stop immediately and do not test remaining permutations!
      if (probe.exists && probe.code === 250) {
        verifiedEmail = candidateEmail;
        finalStatus = 'VERIFIED';
        break;
      } else if (probe.isPolicy) {
        verifiedEmail = candidateEmail;
        finalStatus = 'VERIFIED';
        break;
      } else if (probe.code === 550) {
        // User not found on this pattern, move to next pattern
        continue;
      }
    }

    if (verifiedEmail) {
      return {
        status: finalStatus,
        foundEmail: verifiedEmail,
        provider: `${mxInfo.provider} (Precise)`,
        nowTime,
        leadForDetails: [fullName, verifiedEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    } else {
      return {
        status: 'USER_NOT_FOUND',
        foundEmail: permutations[0] || '',
        provider: mxInfo.provider,
        nowTime,
        leadForDetails: null,
      };
    }
  } catch (err) {
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
  console.log('⚡ Starting 15-Pattern High-Speed Lead Finder...');
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

  // Load Details rows to prevent duplicates
  const detailsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Details'!A:Z",
  });
  const [dHeaders, ...dRows] = detailsRes.data.values || [];
  const existingEmails = new Set(dRows.map(r => (r[1] || '').trim().toLowerCase()));

  // Filter queue of pending rows
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

  console.log(`📋 Found ${pendingLeads.length} leads to process in parallel (Concurrency: ${CONCURRENCY_LIMIT})...\n`);

  const newDetailsRows = [];
  let foundCount = 0;
  let invalidCount = 0;

  // Process in parallel chunks of CONCURRENCY_LIMIT (5 at a time)
  for (let i = 0; i < pendingLeads.length; i += CONCURRENCY_LIMIT) {
    const chunk = pendingLeads.slice(i, i + CONCURRENCY_LIMIT);

    const results = await Promise.all(chunk.map(lead => processSingleLead(lead)));

    for (let j = 0; j < chunk.length; j++) {
      const lead = chunk[j];
      const res = results[j];

      // Update in-memory row
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
        console.log(`✅ [${res.status}] ${lead.fullName} -> ${res.foundEmail}`);
      } else {
        invalidCount++;
        console.log(`❌ [${res.status}] ${lead.fullName} (${lead.rawDomain})`);
      }
    }

    // Write back progress in chunks to Google Sheets
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

  // Batch insert verified leads to Details tab
  if (newDetailsRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Details'!A:L",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newDetailsRows },
    });
    console.log(`\n🚀 Transferred ${newDetailsRows.length} verified leads to "Details" tab.`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🏁 Finished in ${durationSec}s! Total Verified/Catch-All: ${foundCount}, Rejected/Invalid: ${invalidCount}`);
}

runEmailFinder().catch(console.error);
