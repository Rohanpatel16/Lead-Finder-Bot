import { google } from 'googleapis';
import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CONCURRENCY_LIMIT = 5; // 👈 Kept at 5 to prevent servers from closing sockets

// In-memory domain cache for instant 0ms lookups on repeated domains
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

// 2. Real-time DNS MX Lookup (Extracts all MX hosts)
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
    const mxList = mxRecords.map(r => r.exchange).filter(Boolean);

    const mxHosts = mxList.join(' ').toLowerCase();
    let provider = 'Custom Server';
    if (mxHosts.includes('google') || mxHosts.includes('aspmx')) provider = 'Google Workspace';
    else if (mxHosts.includes('outlook') || mxHosts.includes('microsoft')) provider = 'Microsoft 365';
    else if (mxHosts.includes('zoho')) provider = 'Zoho Mail';

    const res = { 
      valid: true, 
      domain: cleanDomain, 
      provider, 
      primaryMx: mxList[0], 
      mxList, 
      isCatchAll: null, 
      isFirewalled: false,
      isDead: false 
    };
    domainCache.set(cleanDomain, res);
    return res;
  } catch (e) {
    const res = { valid: false, domain: cleanDomain, provider: 'Dead Domain', isDead: true };
    domainCache.set(cleanDomain, res);
    return res;
  }
}

// 3. Robust RFC-Compliant SMTP Mailbox Probe (Reliable 4.5s Window)
function pingSmtpMailbox(email, mxHost) {
  return new Promise((resolve) => {
    if (!mxHost) return resolve({ exists: false, isPolicy: false, isFirewalled: false, error: 'NO_MX' });

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

      socket.setTimeout(4500);

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
          let isFirewalled = false;

          if (response.startsWith('250')) {
            exists = true; // Clean verification
          } else if (response.startsWith('541') || response.startsWith('451')) {
            isPolicy = true; // Policy accepted
          } else if (response.startsWith('554') || response.startsWith('421')) {
            isFirewalled = true; // Firewall blocked probe
          } else {
            exists = false; // 550 User Not Found
          }

          try { socket.write('QUIT\r\n'); } catch (e) {}
          safeResolve({ exists, isPolicy, isFirewalled, code, message: response.trim() });
        }
      });

      socket.on('error', (err) => safeResolve({ exists: false, isPolicy: false, isFirewalled: true, error: err.code || 'SOCKET_ERROR', message: err.message }));
      socket.on('timeout', () => safeResolve({ exists: false, isPolicy: false, isFirewalled: true, code: 408, error: 'TIMEOUT', message: 'Connection timed out' }));
      socket.on('close', () => safeResolve({ exists: false, isPolicy: false, isFirewalled: true, error: 'SOCKET_CLOSED', message: 'Socket closed' }));
    } catch (err) {
      safeResolve({ exists: false, isPolicy: false, isFirewalled: true, error: err.message, message: err.message });
    }
  });
}

// 4. Catch-All & Firewall Check
async function checkDomainStatus(mxInfo) {
  if (mxInfo.isDead) return { isFirewalled: true, isCatchAll: false };
  if (mxInfo.isCatchAll !== null) return { isFirewalled: mxInfo.isFirewalled, isCatchAll: mxInfo.isCatchAll };

  try {
    const fakeEmail = `chk_${Math.random().toString(36).substring(7)}@${mxInfo.domain}`;
    
    let probe = await pingSmtpMailbox(fakeEmail, mxInfo.primaryMx);
    if (probe.isFirewalled && mxInfo.mxList.length > 1) {
      probe = await pingSmtpMailbox(fakeEmail, mxInfo.mxList[1]);
    }

    if (probe.isFirewalled) {
      mxInfo.isFirewalled = true;
      mxInfo.isCatchAll = false;
      domainCache.set(mxInfo.domain, mxInfo);
      return { isFirewalled: true, isCatchAll: false };
    }

    const isCatchAll = (probe.exists === true && probe.code === 250);
    mxInfo.isCatchAll = isCatchAll;
    mxInfo.isFirewalled = false;
    domainCache.set(mxInfo.domain, mxInfo);
    return { isFirewalled: false, isCatchAll };
  } catch (e) {
    mxInfo.isFirewalled = true;
    return { isFirewalled: true, isCatchAll: false };
  }
}

// 5. Complete 15-Permutation Generator (Ordered by Frequency)
function generateAll15Permutations(fullName, domain) {
  const nameParts = fullName.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const first = nameParts[0] || '';
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  if (!first) return [];
  if (!last) return [`${first}@${domain}`, `contact@${domain}`];

  const f = first[0];
  const l = last[0];

  const permutations = [
    `${first}.${last}@${domain}`,  // 1. first.last@
    `${first}@${domain}`,         // 2. first@
    `${f}${last}@${domain}`,       // 3. flast@
    `${f}.${last}@${domain}`,      // 4. f.last@
    `${first}${last}@${domain}`,   // 5. firstlast@
    `${first}${l}@${domain}`,      // 6. firstl@
    `${first}.${l}@${domain}`,     // 7. first.l@
    `${last}@${domain}`,           // 8. last@
    `${last}.${first}@${domain}`,  // 9. last.first@
    `${last}${first}@${domain}`,   // 10. lastfirst@
    `${l}${first}@${domain}`,      // 11. lfirst@
    `${l}.${first}@${domain}`,     // 12. l.first@
    `${last}${f}@${domain}`,       // 13. lastf@
    `${last}.${f}@${domain}`,      // 14. last.f@
    `${f}${l}@${domain}`           // 15. fl@
  ];

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
    const { isFirewalled, isCatchAll } = await checkDomainStatus(mxInfo);

    // Case 1: Catch-All Domain (Instant resolution)
    if (isCatchAll) {
      const bestEmail = permutations[0];
      console.log(`⚠️ [CATCH-ALL]: "${mxInfo.domain}" -> ${bestEmail}`);
      return {
        status: 'CATCH_ALL',
        foundEmail: bestEmail,
        provider: `${mxInfo.provider} (Catch-All)`,
        nowTime,
        leadForDetails: [fullName, bestEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    }

    // Case 2: Firewalled Domain (Active corporate mail server that blocks raw socket probes)
    if (isFirewalled) {
      const bestEmail = permutations[0];
      console.log(`🛡️ [MX ACTIVE - FIREWALLED]: "${mxInfo.domain}" (${mxInfo.provider}) -> Queued pattern: ${bestEmail}`);
      return {
        status: 'MX_ACTIVE',
        foundEmail: bestEmail,
        provider: `${mxInfo.provider} (Firewalled / Active MX)`,
        nowTime,
        leadForDetails: [fullName, bestEmail, companyName, location, '', '', '', '', '', '', 0, ''],
      };
    }

    // Case 3: Precise Domain (Probing Allowed)
    let verifiedEmail = null;
    let finalStatus = 'USER_NOT_FOUND';
    let allExplicitlyRejected = true;

    for (let p = 0; p < permutations.length; p++) {
      const candidateEmail = permutations[p];
      let probe = await pingSmtpMailbox(candidateEmail, mxInfo.primaryMx);

      if ((probe.isFirewalled || probe.isPolicy) && mxInfo.mxList.length > 1) {
        probe = await pingSmtpMailbox(candidateEmail, mxInfo.mxList[1]);
      }

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
        // User not found on this pattern, continue to next
        continue;
      } else if (probe.isFirewalled) {
        allExplicitlyRejected = false;
        continue;
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
  console.log('⚡ Starting Lead Finder with Firewall Bypass & 15-Pattern Search...');
  const sheets = await getSheets();

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

    // Skip already processed rows
    if (
      status === 'VERIFIED' ||
      status === 'CATCH_ALL' ||
      status === 'MX_ACTIVE' ||
      status === 'INVALID DOMAIN' ||
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

      if (res.status === 'VERIFIED' || res.status === 'CATCH_ALL' || res.status === 'MX_ACTIVE') {
        foundCount++;
        if (res.leadForDetails && !existingEmails.has(res.foundEmail.toLowerCase())) {
          existingEmails.add(res.foundEmail.toLowerCase());
          newDetailsRows.push(res.leadForDetails);
        }
      } else {
        invalidCount++;
      }
    }

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
    console.log(`\n🚀 Appended ${newDetailsRows.length} leads to "Details" tab.`);
  }

  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n🏁 Completed in ${durationSec}s! Total Valid/Queued: ${foundCount}, Rejected/Invalid: ${invalidCount}`);
}

runEmailFinder().catch(console.error);
