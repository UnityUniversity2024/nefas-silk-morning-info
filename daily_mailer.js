const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'index.html';

async function fetchArabicaPrice() {
    try {
        const response = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/KC=F', { timeout: 10000 });
        const data = await response.json();
        const price = data.chart.result[0].meta.regularMarketPrice;
        return price ? '$' + (parseFloat(price) / 100).toFixed(2) : 'N/A';
    } catch (e) { 
        console.log('Yahoo Finance timeout bypassed.');
        return 'N/A'; 
    }
}

async function fetchForexRates() {
    try {
        const date = new Date().toISOString().slice(0, 10);
        const response = await fetch(`https://combanketh.et/cbeapi/daily-exchange-rates/?_limit=1&Date=${date}`, { timeout: 10000 });
        const data = await response.json();
        const rates = data?.[0]?.ExchangeRate || [];
        
        const getRate = (code) => {
            const r = rates.find(x => x.currency?.CurrencyCode === code);
            return r && r.transactionalSelling ? r.transactionalSelling.toFixed(2) : 'N/A';
        };

        if (rates.length === 0) throw new Error("CBE API empty");

        return { USD: getRate('USD'), EUR: getRate('EUR'), GBP: getRate('GBP'), CNY: getRate('CNY'), AED: getRate('AED') };
    } catch (e) {
        console.log("CBE API blocked GitHub. Switching to global fallback...");
        try {
            const response = await fetch('https://open.er-api.com/v6/latest/USD', { timeout: 10000 });
            const data = await response.json();
            const etb = data.rates.ETB;
            return {
                USD: etb.toFixed(2),
                EUR: (etb / data.rates.EUR).toFixed(2),
                GBP: (etb / data.rates.GBP).toFixed(2),
                CNY: (etb / data.rates.CNY).toFixed(2),
                AED: (etb / data.rates.AED).toFixed(2)
            };
        } catch (err) {
            return { USD: 'N/A', EUR: 'N/A', GBP: 'N/A', CNY: 'N/A', AED: 'N/A' };
        }
    }
}

async function scrapeInvestingCom(browser, url, name) {
    let page;
    try {
        page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await new Promise(r => setTimeout(r, 2000));
        const price = await page.evaluate(() => {
            const el = document.querySelector('[data-test="instrument-price-last"]');
            return el ? el.innerText.trim() : 'N/A';
        });
        await page.close();
        return price;
    } catch (e) {
        console.log(`Scraper timeout bypassed for ${name}`);
        if (page) await page.close().catch(() => {});
        return 'N/A';
    }
}

async function runAutomation() {
    let browser;
    try {
        console.log('1. Fetching APIs...');
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        console.log('2. Launching browser...');
        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
        });

        const robustaRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee', 'Robusta');
        const brentRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil', 'Brent');
        const soyRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans', 'Soy');
        const rubberRaw = await scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures', 'Rubber');

        const robustaLivePrice = robustaRaw && robustaRaw !== 'N/A' ? '$' + robustaRaw.replace(/,/g, '') : 'N/A';
        const brentLivePrice = brentRaw && brentRaw !== 'N/A' ? '$' + brentRaw : 'N/A';
        const soyLivePrice = soyRaw && soyRaw !== 'N/A' ? '$' + soyRaw : 'N/A';
        const rubberLivePrice = rubberRaw && rubberRaw !== 'N/A' ? '$' + rubberRaw : 'N/A';

        console.log('3. Updating HTML...');
        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        
        try { await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 10000 }); } 
        catch (e) { console.log('Bypassed HTML load timeout'); }

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });
        
        const brentNum = brentRaw !== 'N/A' ? parseFloat(brentRaw) : 0;
        const rubberNum = rubberRaw !== 'N/A' ? parseFloat(rubberRaw) : 0;
        
        await page.evaluate((arabica, robusta, brent, soy, rubber, brentNum, rubberNum, fx, dateStr) => {
            if (arabica !== 'N/A' && document.getElementById('arabica-price')) document.getElementById('arabica-price').innerText = arabica;
            if (robusta !== 'N/A' && document.getElementById('robusta-price')) document.getElementById('robusta-price').innerText = robusta;
            if (brent !== 'N/A' && document.getElementById('brent-price')) document.getElementById('brent-price').innerText = brent;
            if (soy !== 'N/A' && document.getElementById('soy-price')) document.getElementById('soy-price').innerText = soy;
            if (rubber !== 'N/A' && document.getElementById('rubber-price')) document.getElementById('rubber-price').innerText = rubber;
            
            if (fx.USD !== 'N/A' && document.getElementById('fx-usd')) document.getElementById('fx-usd').innerText = fx.USD;
            if (fx.EUR !== 'N/A' && document.getElementById('fx-eur')) document.getElementById('fx-eur').innerText = fx.EUR;
            if (fx.GBP !== 'N/A' && document.getElementById('fx-gbp')) document.getElementById('fx-gbp').innerText = fx.GBP;
            if (fx.CNY !== 'N/A' && document.getElementById('fx-cny')) document.getElementById('fx-cny').innerText = fx.CNY;
            if (fx.AED !== 'N/A' && document.getElementById('fx-aed')) document.getElementById('fx-aed').innerText = fx.AED;
            
            if (document.getElementById('report-date')) document.getElementById('report-date').innerText = "Last Updated: " + dateStr;
            
            if (document.getElementById('brent-num-data')) document.getElementById('brent-num-data').innerText = brentNum;
            if (document.getElementById('rubber-num-data')) document.getElementById('rubber-num-data').innerText = rubberNum;
            if (document.getElementById('usd-num-data')) document.getElementById('usd-num-data').innerText = fx.USD;
        }, arabicaLivePrice, robustaLivePrice, brentLivePrice, soyLivePrice, rubberLivePrice, brentNum, rubberNum, forexRates, dateStr);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        await browser.close();

        console.log('4. Dispatching Email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        const emailHTML = `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);">
                <div style="background: #0f172a; padding: 25px; text-align: center;">
                    <h2 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 900; text-transform: uppercase;">CEO Strategic Brief</h2>
                    <p style="margin: 5px 0 0; color: #94a3b8; font-size: 12px; font-weight: bold; letter-spacing: 1px;">${dateStr}</p>
                </div>
                <div style="padding: 30px;">
                    <p style="margin: 0 0 20px; color: #334155; font-size: 14px; text-align: center;">Your interactive <strong>Analytics Dashboard</strong> is attached. Double-click the file to open it securely in any browser.</p>
                    
                    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                        <h4 style="margin: 0 0 10px; font-size: 12px; text-transform: uppercase; color: #0f172a; border-bottom: 1px solid #cbd5e1; padding-bottom: 5px;">🌍 Official Forex Rates</h4>
                        <div style="display: flex; justify-content: space-between; font-size: 14px; font-weight: bold;">
                            <span style="color: #64748b;">USD: <span style="color: #0f172a;">${forexRates.USD}</span></span>
                            <span style="color: #64748b;">EUR: <span style="color: #0f172a;">${forexRates.EUR}</span></span>
                            <span style="color: #64748b;">CNY: <span style="color: #0f172a;">${forexRates.CNY}</span></span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `CEO Interactive Dashboard - ${dateStr}`,
            html: emailHTML,
            attachments: [{ filename: `CEO_Analytics_Dashboard.html`, path: path.join(__dirname, FILE_NAME) }]
        });
        
        console.log('Script completely finished. Success!');
    } catch (error) {
        console.error('Non-Fatal Error Encountered:', error.message);
    }
}
runAutomation();
