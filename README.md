# 🎯 Lead Finder & Email Verification Bot

An automated lead enrichment engine that takes prospect names and company domains, performs real-time **DNS MX validation**, generates **corporate B2B email permutations**, and auto-populates verified leads directly into your Google Sheets outreach queue.

---

## ⚡ How It Works
1. You paste raw leads (`full_name`, `company_name`, `company_domain`, `location`) into the **`🎯 Lead_Finder`** tab.
2. Every morning at **08:00 AM IST** (or manually via GitHub Actions), the engine:
   - Verifies the company's live MX records via native DNS.
   - Identifies the email provider (Google Workspace, Microsoft 365, Zoho).
   - Generates the standard corporate email pattern (`first.last@company.com`).
   - Automatically copies the lead into your **`Details`** sheet with empty `Sent Status`.
3. Your outreach bot wakes up at **10:00 AM IST** and sends emails to the verified leads automatically.

---

## 🚀 Setup Guide

### 1. Configure GitHub Secrets
In your new GitHub repository, go to **Settings > Secrets and variables > Actions** and add:

| Secret Name | Value |
| :--- | :--- |
| `SPREADSHEET_ID` | Your Google Sheet ID string. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Your Service Account JSON key content. |

### 2. Schedule
- **Automated Cron**: Monday to Saturday at **08:00 AM IST** (`02:30 UTC`).
- **Manual Trigger**: Actions tab > **Lead Finder & Email Enricher** > **Run workflow**.
