/**
 * 🚀 1-CLICK OUTREACH + LEAD FINDER SHEET BUILDER
 */
function createOutreachSystem() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const schema = {
    '📖 Setup_Guide': {
      color: '#0F172A',
      headers: ['Section / Step', 'Instructions & Rules', 'Important Notes'],
      sampleData: [
        ['1. Lead Finder', 'Add prospect Name, Company Name, and Domain in "Lead_Finder" tab. Leave status blank.', 'Run finder.mjs — it finds the verified email and pushes it to "Details" automatically!'],
        ['2. Cold Outreach', 'New leads in "Details" with empty "Sent Status" will be emailed automatically at 10:00 AM IST.', 'Never edit "Sent Status" manually on active leads.']
      ]
    },
    '🎯 Lead_Finder': {
      color: '#0284C7', // Sky Blue
      headers: [
        'full_name', 'company_name', 'company_domain', 'location', 
        'Status', 'Found Email', 'Mail Provider', 'Processed Time'
      ],
      sampleData: [
        ['Nithin Kamath', 'Zerodha', 'zerodha.com', 'Bengaluru', '', '', '', ''],
        ['Harshil Mathur', 'Razorpay', 'razorpay.com', 'Bengaluru', '', '', '', '']
      ]
    },
    'Details': {
      color: '#1A73E8',
      headers: [
        'full_name', 'email', 'company_name', 'location', 
        'Subject Line', 'Sent From', 'Sent Status', 'Time', 
        'Date Sent', 'Follow up', 'Follow Up Count', 'Next Follow Up Date'
      ],
      sampleData: [
        ['John Doe', 'john@example.com', 'Acme Corp', 'Bengaluru', '', '', '', '', '', '', '', '']
      ]
    },
    'Aliases': {
      color: '#EC4899',
      headers: ['alias_email', 'display_name', 'is_active'],
      sampleData: [
        ['pooja@hireologist.co.in', 'Pooja', 'TRUE'],
        ['neha@hireologist.co.in', 'Neha', 'TRUE']
      ]
    },
    'Inboxes': {
      color: '#059669',
      headers: [
        'email', 'display_name', 'smtp_host', 'smtp_port', 
        'smtp_user', 'smtp_pass', 'imap_host', 'imap_port', 
        'daily_limit', 'is_active'
      ],
      sampleData: [
        ['Abhishek@hireologist.co.in', 'Abhishek', 'smtp.gmail.com', '465', 'Abhishek@hireologist.co.in', 'your-app-password', 'imap.gmail.com', '993', '50', 'TRUE']
      ]
    },
    'Settings': {
      color: '#4B5563',
      headers: ['Key', 'Value', 'Description'],
      sampleData: [
        ['min_delay_seconds', '15', 'Minimum seconds to wait between sending emails'],
        ['max_delay_seconds', '45', 'Maximum seconds to wait between sending emails'],
        ['cutoff_hour_ist', '18', 'Stop sending at this hour in IST (18 = 6 PM)'],
        ['cutoff_minute_ist', '30', 'Stop sending at this minute in IST (30 = 6:30 PM)'],
        ['discord_updates_webhook', 'https://discord.com/api/webhooks/...', 'Channel webhook for Start/End alerts'],
        ['discord_positive_webhook', 'https://discord.com/api/webhooks/...', 'Channel webhook for Positive/Neutral reply alerts'],
        ['groq_api_key', 'gsk_...', 'Groq API Key for AI Sentiment & Summary']
      ]
    },
    'Templates': {
      color: '#7C3AED',
      headers: ['Template_Name', 'Subject', 'Body'],
      sampleData: [
        ['Cold Pitch V1', 'Quick question for {{company_name}} - {{Date}}', 'Hi {{full_name}},\n\nNoticed your rapid expansion in {{location}}.\n\nWould you be open to a quick 5-min sync this week?\n\nBest,\nTeam']
      ]
    },
    'Followup_Templates': {
      color: '#D97706',
      headers: ['Follow_Up_Number', 'Days_Until_Next', 'Subject', 'Body'],
      sampleData: [
        ['1', '3', 'Re:', 'Hi {{full_name}},\n\nJust following up on my previous note regarding {{company_name}}.\n\nBest,\nTeam']
      ]
    },
    'Locations': {
      color: '#2563EB',
      headers: ['location_name'],
      sampleData: [['Mumbai'], ['Delhi'], ['Bengaluru'], ['Hyderabad'], ['Ahmedabad'], ['Pune'], ['Gurgaon']]
    },
    'Clients': {
      color: '#DC2626',
      headers: ['client_name', 'industry'],
      sampleData: [['Bajaj', 'Global'], ['ICICI', 'Global'], ['Turing', 'IT']]
    }
  };

  Object.keys(schema).forEach(sheetName => {
    let sheet = ss.getSheetByName(sheetName);
    if (!sheet) sheet = ss.insertSheet(sheetName);
    else sheet.clear();

    const { headers, sampleData, color } = schema[sheetName];

    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setFontColor('#FFFFFF');
    headerRange.setBackground(color);
    headerRange.setHorizontalAlignment('center');

    if (sampleData.length > 0) {
      sheet.getRange(2, 1, sampleData.length, sampleData[0].length).setValues(sampleData);
    }

    sheet.setFrozenRows(1);
    for (let c = 1; c <= headers.length; c++) {
      sheet.autoResizeColumn(c);
    }
  });

  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) ss.deleteSheet(defaultSheet);

  ss.getSheetByName('🎯 Lead_Finder').activate();
  SpreadsheetApp.getUi().alert('✅ Sheet setup created with Lead_Finder and Details tabs!');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Outreach Bot')
    .addItem('🛠️ Rebuild / Reset All Sheets', 'createOutreachSystem')
    .addToUi();
}
