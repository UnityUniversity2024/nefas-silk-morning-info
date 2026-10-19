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
    } catch (e) { return 'N/A'; }
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

        if (rates.length === 0) throw new Error("CBE fallback");

        return { USD: getRate('USD'), EUR: getRate('EUR'), GBP: getRate('GBP'), CNY: getRate('CNY'), AED: getRate('AED') };
    } catch (e) {
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
        if (page) await page.close().catch(() => {});
        return 'N/A';
    }
}

// Scrapes the full ECX table from https://ecx.eem.et/
async function scrapeFullECX(browser) {
    let page;
    try {
        page = await browser.newPage();
        await page.goto('https://ecx.eem.et/', { waitUntil: 'networkidle2', timeout: 20000 });
        await new Promise(r => setTimeout(r, 3000));

        const rows = await page.evaluate(() => {
            const tableRows = Array.from(document.querySelectorAll('table tbody tr'));
            if (tableRows.length === 0) return null;

            return tableRows.map(row => {
                const cols = Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim());
                return {
                    nameSymbol: cols[0] || '',
                    grade: cols[1] || '',
                    type: cols[2] || '',
                    warehouse: cols[3] || '',
                    closePrice: cols[4] || '',
                    change: cols[6] || cols[5] || '',
                    volume: cols[7] || cols[6] || ''
                };
            });
        });

        await page.close();
        return rows;
    } catch (e) {
        console.log('ECX scraper bypassed: ' + e.message);
        if (page) await page.close().catch(() => {});
        return null;
    }
}

async function runAutomation() {
    let browser;
    try {
        console.log('1. Pulling market feeds & CBE Forex...');
        const [arabicaLivePrice, forexRates] = await Promise.all([
            fetchArabicaPrice(),
            fetchForexRates()
        ]);

        browser = await puppeteer.launch({ 
            headless: 'new', 
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
        });

        console.log('2. Scraping commodities & full ECX data...');
        const [robustaRaw, brentRaw, soyRaw, rubberRaw, ecxData] = await Promise.all([
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/london-coffee', 'Robusta'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/brent-oil', 'Brent'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/us-soybeans', 'Soy'),
            scrapeInvestingCom(browser, 'https://www.investing.com/commodities/rubber-rss3-futures', 'Rubber'),
            scrapeFullECX(browser)
        ]);

        const robustaLivePrice = robustaRaw && robustaRaw !== 'N/A' ? '$' + robustaRaw.replace(/,/g, '') : 'N/A';
        const brentLivePrice = brentRaw && brentRaw !== 'N/A' ? '$' + brentRaw : 'N/A';
        const soyLivePrice = soyRaw && soyRaw !== 'N/A' ? '$' + soyRaw : 'N/A';
        const rubberLivePrice = rubberRaw && rubberRaw !== 'N/A' ? '$' + rubberRaw : 'N/A';

        console.log('3. Injecting into CEO Dashboard...');
        const page = await browser.newPage();
        const filePath = 'file://' + path.join(__dirname, FILE_NAME);
        
        try { await page.goto(filePath, { waitUntil: 'domcontentloaded', timeout: 10000 }); } 
        catch (e) { console.log('Bypassed HTML load timeout'); }

        const dateStr = new Date().toLocaleString('en-US', { timeZone: 'Africa/Addis_Ababa' });
        const brentNum = brentRaw !== 'N/A' ? parseFloat(brentRaw) : 0;
        const rubberNum = rubberRaw !== 'N/A' ? parseFloat(rubberRaw) : 0;

        await page.evaluate((arabica, robusta, brent, soy, rubber, brentNum, rubberNum, fx, dateStr, ecx) => {
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

            // Injects dynamic rows if scraped from ECX portal
            if (ecx && ecx.length > 0 && document.getElementById('ecx-table-body')) {
                const tbody = document.getElementById('ecx-table-body');
                tbody.innerHTML = '';
                ecx.forEach(item => {
                    const isPositive = (item.change || '').includes('+');
                    const badgeClass = isPositive 
                        ? 'color: #10b981; background: #ecfdf5; padding: 2px 8px; border-radius: 12px; font-weight: bold; font-size: 12px;'
                        : 'color: #e11d48; background: #fff1f2; padding: 2px 8px; border-radius: 12px; font-weight: bold; font-size: 12px;';

                    const tr = document.createElement('tr');
                    tr.className = 'hover:bg-slate-50 transition-colors';
                    tr.innerHTML = `
                        <td class="px-6 py-4 font-black text-slate-900">${item.nameSymbol}</td>
                        <td class="px-6 py-4 font-medium text-slate-600">${item.grade}</td>
                        <td class="px-6 py-4 font-medium text-slate-600">${item.type}</td>
                        <td class="px-6 py-4 font-medium text-slate-600">${item.warehouse}</td>
                        <td class="px-6 py-4 font-black text-slate-900">${item.closePrice}</td>
                        <td class="px-6 py-4"><span style="${badgeClass}">${item.change}</span></td>
                        <td class="px-6 py-4 font-medium text-slate-600">${item.volume}</td>
                    `;
                    tbody.appendChild(tr);
                });
            }
        }, arabicaLivePrice, robustaLivePrice, brentLivePrice, soyLivePrice, rubberLivePrice, brentNum, rubberNum, forexRates, dateStr, ecxData);

        const updatedHTML = await page.content();
        fs.writeFileSync(path.join(__dirname, FILE_NAME), updatedHTML);
        await browser.close();

        console.log('4. Dispatching Email...');
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });

        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: process.env.BOSS_EMAIL,
            subject: `CEO Strategic Dashboard & Complete ECX Summary - ${dateStr}`,
            html: `<div style="font-family:sans-serif;padding:20px;color:#0f172a;">
                <h2>CEO Strategic Intelligence Report</h2>
                <p>Date: <strong>${dateStr}</strong></p>
                <p>The daily interactive dashboard containing global commodities, verified CBE exchange rates, and the <strong>full ECX Daily Trade Summary</strong> is attached.</p>
                <p><em>Double-click the attached HTML file to open in your browser.</em></p>
            </div>`,
            attachments: [{ filename: `CEO_Analytics_Dashboard.html`, path: path.join(__dirname, FILE_NAME) }]
        });
        
        console.log('Automation complete. Sent to ' + process.env.BOSS_EMAIL);
    } catch (error) {
        console.error('Pipeline Error:', error);
    }
}
runAutomation();
