# pred-ref (Railway Ready)

Automated referral bot for pred.app with 2Captcha & Puppeteer.
Configured for automated, non-interactive execution on Railway or Docker environments.

## Environment Variables on Railway

Set these in your Railway service settings (**Variables**):

- `MNEMONIC`: Your 12/24-word seed phrase
- `REFERRAL_CODE`: Target referral code
- `MAX_INDEX`: Total wallets to scan/process (e.g. `500`)
- `DELAY_MS`: Delay between wallets in ms (e.g. `5000`)
- `CAPTCHA_API_KEY`: 2Captcha API key

## Running
On Railway or Docker, it will automatically launch Mode 2 (`Run Bot Auto`) without asking for manual confirmation.
