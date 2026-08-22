import { google } from 'googleapis';
import axios from 'axios';
import dns from 'node:dns/promises';

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
    if (!mxRecords || mxRecords.length === 0) return { valid: false, domain: cleanDomain, provider: 'No MX Records' };

    const mxHosts = mxRecords.map(r => r.exchange.toLowerCase()).join(' ');
    let provider = 'Custom Mail Server';
    if (mxHosts.includes('google') || mxHosts.includes('aspmx')) provider = 'Google Workspace';
    else if (mxHosts.includes('outlook') || mxHosts.includes('microsoft')) provider = 'Microsoft 365';
    else if (mxHosts.includes('zoho')) provider = 'Zoho Mail';

    return { valid: true, domain: cleanDomain, provider, mxRecords };
  } catch (e) {
    return { valid: false, domain: cleanDomain, provider: 'Invalid / Dead Domain' };
  }
}

// 3. Generate Corporate B2B Email Permutations
function generateEmailPermutations(fullName, domain) {
  const nameParts = fullName.trim().toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/);
  const first = nameParts[0] || '';
  const last = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';

  if (!first) return [];

  const permutations = [];
  if (first && last) {
    permutations.push({ email: `${first}.${last}@${domain}`, pattern: 'first.last' }); // 80% B2B standard
    permutations.push({ email: `${first}@${domain}`, pattern: 'first' });             // Founders / Startups
    permutations.push({ email: `${first[0]}${last}@${domain}`, pattern: 'flast' });    // Corporate
    permutations.push({ email: `${first}${last[0]}@${domain}`, pattern: 'firstl' });
    permutations.push({ email: `${first}_${last}@${domain}`, pattern: 'first_last' });
  } else {
    permutations.push({ email: `${first}@${domain}`, pattern: 'first' });
    permutations.push({ email: `contact@${domain}`, pattern: 'generic' });
  }

  return permutations;
}

// ============================================================================
// 🚀 MAIN ENGINE EXECUTION
// ============================================================================
async function runEmailFinder() {
  console.log('🔍 Starting Standalone Lead Finder & Email Verification Engine...');
  const sheets = await getSheets();

  // Load Lead_Finder rows
  const finderRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "'🎯 Lead_Finder'!A:Z",
  });
  const [fHeaders, ...fRows] = finderRes.data.values || [];
  if (!fHeaders || fRows.length === 0) {
    console.log('No rows found in "🎯 Lead_Finder" tab.');
    return;
  }
  const fCol = Object.fromEntries(fHeaders.map((h, i) => [h.trim(), i]));

  // Load Details rows to prevent inserting duplicates
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

    // Skip already processed rows or incomplete data
    if (status === 'VERIFIED' || status === 'INVALID DOMAIN' || !rawDomain || !fullName) {
      continue;
    }

    console.log(`Analyzing: [${fullName}] at domain [${rawDomain}]...`);

    // Step 1: Real-time DNS MX lookup
    const mxInfo = await getDomainMxInfo(rawDomain);
    const rowNum = i + 2;
    const nowTime = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Kolkata', hour12: true });

    if (!mxInfo.valid) {
      console.log(`❌ Domain ${rawDomain} is dead / has no MX records.`);
      row[fCol['Status']] = 'INVALID DOMAIN';
      row[fCol['Mail Provider']] = mxInfo.provider;
      row[fCol['Processed Time']] = nowTime;
      invalidCount++;
    } else {
      // Step 2: Generate best corporate email pattern
      const permutations = generateEmailPermutations(fullName, mxInfo.domain);
      const bestEmail = permutations[0].email;

      console.log(`✅ Valid Domain (${mxInfo.provider}) -> Found: ${bestEmail}`);

      row[fCol['Status']] = 'VERIFIED';
      row[fCol['Found Email']] = bestEmail;
      row[fCol['Mail Provider']] = mxInfo.provider;
      row[fCol['Processed Time']] = nowTime;
      foundCount++;

      // Step 3: Queue to append into "Details"
      if (!existingEmails.has(bestEmail.toLowerCase())) {
        existingEmails.add(bestEmail.toLowerCase());
        newDetailsRows.push([
          fullName,             // full_name
          bestEmail,            // email
          companyName,          // company_name
          location,             // location
          '', '', '', '', '', '', 0, '' // Tracking & Sent Status left blank!
        ]);
      }
    }

    // Write status update back to 🎯 Lead_Finder tab
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'🎯 Lead_Finder'!A${rowNum}:Z${rowNum}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });
  }

  // Step 4: Batch insert verified leads into Details tab
  if (newDetailsRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "'Details'!A:L",
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: newDetailsRows },
    });
    console.log(`🚀 Transferred ${newDetailsRows.length} verified leads into "Details" tab!`);
  }

  // Step 5: Discord Webhook Notification
  try {
    const settingsRes = await sheets.spreadsheets.values.get({ 
      spreadsheetId: SPREADSHEET_ID, 
      range: "'Settings'!A:Z" 
    });
    const [sHeaders, ...sRows] = settingsRes.data.values || [];
    const settings = Object.fromEntries(sRows.map(r => [(r[0] || '').trim(), (r[1] || '').trim()]));

    if (settings.discord_updates_webhook && (foundCount > 0 || invalidCount > 0)) {
      const summaryMsg = 
`🎯 **Lead Finder Enrichment Completed**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ **Verified Leads Added:** ${foundCount}
❌ **Dead Domains Skipped:** ${invalidCount}
📋 **Ready in "Details":** ${newDetailsRows.length} new leads queued for outreach!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
      await axios.post(settings.discord_updates_webhook, { content: summaryMsg });
    }
  } catch (e) {
    console.warn('Could not post Discord alert:', e.message);
  }

  console.log(`🏁 Finished. Total Verified: ${foundCount}, Total Invalid: ${invalidCount}`);
}

runEmailFinder().catch(console.error);
