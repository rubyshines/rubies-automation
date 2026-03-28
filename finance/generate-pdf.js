const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();

  const htmlPath = path.join(__dirname, 'pricing-strategy-report.html');
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  const pdfPath = path.join(__dirname, 'RUBIES-Pricing-Strategy-2026.pdf');
  await page.pdf({
    path: pdfPath,
    format: 'Letter',
    printBackground: true,
    margin: { top: '0.4in', bottom: '0.4in', left: '0.4in', right: '0.4in' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8px;color:#999;width:100%;text-align:center;padding:0 0.4in;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });

  console.log('PDF generated:', pdfPath);
  await browser.close();
})();
