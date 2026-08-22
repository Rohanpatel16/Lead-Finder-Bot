import { google } from 'googleapis';
import axios from 'axios';
import dns from 'node:dns/promises';
import net from 'node:net';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 1. Google Sheets Authentication
async function getSheets() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// 2. Real-time DNS MX Lookup
async function getDomainMxInfo(domain) {
  const cleanDomain = domain.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].trim().toLowerCase();
  try {
    const mxRecords = await dns.resolveMx(cleanDomain);
    if (!mxRecords || mxRecords.length === 0) return { valid: false, domain: cleanDomain, provider: 'No MX' };

    // Sort by lowest priority number (primary mail server)
    mxRecords.sort((a, b) => a.priority - b.priority);
    const primaryMx = mxRecords[0].exchange;

    const mxHosts = mxRecords.map(r => r.exchange.toLowerCase()).join(' ');
    let provider = 'Custom Server';
    if (mxHosts.includes('google') || mxHosts.includes('aspmx')) provider = 'Google Workspace';
    else if (mxHosts.includes('outlook') || mxHosts.includes('microsoft')) provider = 'Microsoft 365';
    else if (mxHosts.includes('zoho')) provider = 'Zoho Mail';

    return { valid: true, domain: cleanDomain, provider, primaryMx, mxRecords };
  } catch (e) {
    return { valid: false, domain: cleanDomain, provider: 'Dead Domain' };
  }
}

// 3. Active SMTP Mailbox Handshake (Port 25 Probe)
function pingSmtpMailbox(email, primaryMx) {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, primaryMx);
    let step = 0;
    let result = { exists: false, code: null, message: '' };

    socket.setTimeout(8000); // 8s timeout

    socket.on('data', (data) => {
      const response = data.toString();

      // Step 1: Mail server greeting
      if (step === 0 && response.startsWith('220')) {
        socket.write('HELO checkmail.com\r\n');
        step++;
      }
      // Step 2: Sender declaration
      else if (step === 1 && response.startsWith('250')) {
        socket.write('MAIL FROM:<verify@checkmail.com>\r\n');
        step++;
      }
      // Step 3: Test recipient address
      else if (step === 2 && response.startsWith('250')) {
        socket.write(`RCPT TO:<${email}>\r\n`);
        step++;
      }
      // Step 4: Evaluate recipient response
      else if (step === 3) {
        result.message = response.trim();
        if (response.startsWith('250')) {
          result.exists = true; // Mailbox confirmed!
          result.code = 250;
        } else if (response.startsWith('550') || response.startsWith('551') || response.startsWith('553')) {
          result.exists = false; // User unknown / fake name
          result.code = 550;
        } else {
          result.exists = false;
          result.code = parseInt(response.slice(0, 3), 10) || 500;
        }

        socket.write('QUIT\r\n');
        socket.end();
        resolve(result);
      }
    });

    socket.on('error', (err) => {
      resolve({ exists: false, error: err.code || 'SOCKET_ERROR' });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ exists: false, error: 'TIMEOUT' });
    });
  });
}

// 4. Generate B2B Email Permutations
function generateEmailPermutations(fullName, domain) {
  const nameParts = fullName.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const first = nameParts[0] || '';
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  if (!first) return [];

  const permutations = [];
  if (first && last) {
    permutations.push(`${first}.${last}@${domain}`); // e.g. rohan.patel@
    permutations.push(`${first}@${domain}`);        // e.g. rohan@
    permutations.push(`${first[0]}${last}@${domain}`); // e.g. rpatel@
  } else {
    permutations.push(`${first}@${domain}`);
  }

  return permutations;
}

// ============================================================================
// 🚀 MAIN LEAD ENRICHMENT FUNCTION
// ============================================================================
async function runEmailFinder() {
  console.log('🔍 Starting Strict Lead Finder & Active Mailbox Verification...');
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

  // Load Details rows to avoid duplicates
  const detailsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'Details'!A:Z",
  });
  const [dHeaders, ...dRows] = detailsRes.data.values || [];
  const existingEmails = new Set(dRows.map(r => (r[1] || '').trim().toLowerCase()));

  const newDetailsRows = [];
  let foundCount = 0;
  let invalidCount = 0;

  for (let i = 0; i < fRows.length; i++) {
    const row = fRows[i];
    const fullName = (row[fCol['full_name']] || '').trim();
    const companyName = (row[fCol['company_name']] || '').trim();
    const rawDomain = (row[fCol['company_domain']] || '').trim();
    const location = (row[fCol['location']] || 'your city').trim();
    const status = (row[fCol['Status']] || '').trim().toUpperCase();

    // Skip already verified or dead rows
    if (status === 'VERIFIED' || status === 'INVALID DOMAIN' || status === 'USER_NOT_FOUND' || !rawDomain || !fullName) {
      continue;
    }

    console.log(`\n🔎 Testing: [${fullName}] at [${rawDomain}]...`);
    const rowNum = i + 2;
    const nowTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

    // Step 1: Check Domain MX
    const mxInfo = await getDomainMxInfo(rawDomain);
    if (!mxInfo.valid) {
      console.log(`❌ Domain ${rawDomain} is dead / has no MX records.`);
      row[fCol['Status']] = 'INVALID DOMAIN';
      row[fCol['Mail Provider']] = mxInfo.provider;
      row[fCol['Processed Time']] = nowTime;
      invalidCount++;
    } else {
      // Step 2: Try permutations and probe mailbox
      const permutations = generateEmailPermutations(fullName, mxInfo.domain);
      let verifiedEmail = null;

      for (const candidateEmail of permutations) {
        console.log(`📡 Pinging SMTP mailbox for: ${candidateEmail}...`);
        const probeResult = await pingSmtpMailbox(candidateEmail, mxInfo.primaryMx);

        if (probeResult.exists && probeResult.code === 250) {
          verifiedEmail = candidateEmail;
          console.log(`✅ Real Mailbox Confirmed: ${candidateEmail}`);
          break;
        } else if (probeResult.code === 550) {
          console.log(`❌ Server rejected ${candidateEmail} (550 User Not Found)`);
        } else {
          // If port 25 is blocked on runner, fallback gracefully based on MX existence
          console.log(`⚠️ SMTP probe unreachable (${probeResult.error || probeResult.code}).`);
        }
      }

      if (verifiedEmail) {
        row[fCol['Status']] = 'VERIFIED';
        row[fCol['Found Email']] = verifiedEmail;
        row[fCol['Mail Provider']] = mxInfo.provider;
        row[fCol['Processed Time']] = nowTime;
        foundCount++;

        if (!existingEmails.has(verifiedEmail.toLowerCase())) {
          existingEmails.add(verifiedEmail.toLowerCase());
          newDetailsRows.push([
            fullName,
            verifiedEmail,
            companyName,
            location,
            '', '', '', '', '', '', 0, ''
          ]);
        }
      } else {
        console.log(`🚫 Could not verify a valid mailbox for ${fullName} at ${rawDomain}`);
        row[fCol['Status']] = 'USER_NOT_FOUND';
        row[fCol['Found Email']] = permutations[0] || '';
        row[fCol['Mail Provider']] = mxInfo.provider;
        row[fCol['Processed Time']] = nowTime;
        invalidCount++;
      }
    }

    // Update Lead_Finder tab
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'🎯 Lead_Finder'!A${rowNum}:Z${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  // Transfer ONLY verified leads to Details
  if (newDetailsRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Details'!A:L",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newDetailsRows },
    });
    console.log(`🚀 Transferred ${newDetailsRows.length} strictly verified leads to "Details" tab.`);
  }

  console.log(`\n🏁 Done. Verified: ${foundCount}, Rejected/Invalid: ${invalidCount}`);
}

runEmailFinder().catch(console.error);
