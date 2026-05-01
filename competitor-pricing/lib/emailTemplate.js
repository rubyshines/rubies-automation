/**
 * Generate HTML email for monthly competitor pricing report.
 * Layout: Price changes (if any) -> Summary bar -> Full category breakdown -> Errors -> Footer
 */
function buildEmail({ date, categoryRows, overall, priceChanges, errors }) {
  const month = new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // --- Price Changes Section (shown first if any) ---
  let changesHtml = '';
  if (priceChanges && priceChanges.length > 0) {
    const catLabels = {
      underwear: 'Underwear', swim_bottom: 'Swim Bottom', swim_top: 'Swim / Bikini Top',
      swimsuit: 'One-Piece', bra: 'Bra', bra_seamless: 'Seamless Bra',
    };
    let changeRows = '';
    for (const c of priceChanges) {
      const delta = Math.round(c.currentPrice - c.previousPrice);
      const pct = c.previousPrice ? Math.round((delta / c.previousPrice) * 100) : 0;
      const arrow = delta > 0 ? '&#9650;' : '&#9660;';
      const color = delta > 0 ? '#c0392b' : '#0a7c42';
      changeRows += `
        <tr>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;font-weight:600;">${c.competitor}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;">${c.productName}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:12px;color:#888;">${catLabels[c.category] || c.category}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;">$${Math.round(c.previousPrice)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;font-weight:600;">$${Math.round(c.currentPrice)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:${color};font-weight:600;">${arrow} $${Math.abs(delta)} (${pct > 0 ? '+' : ''}${pct}%)</td>
        </tr>`;
    }
    changesHtml = `
      <tr><td style="padding:20px 20px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:16px;border-collapse:collapse;">
          <tr><td colspan="6" style="padding:10px;background:#fff3e0;border-left:3px solid #e65100;border-radius:2px;">
            <span style="font-size:14px;font-weight:700;color:#e65100;">&#9888; ${priceChanges.length} Price Change${priceChanges.length > 1 ? 's' : ''} Detected</span>
          </td></tr>
          <tr style="background:#f9f9f9;">
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;">Brand</td>
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;">Product</td>
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;">Category</td>
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;text-align:right;">Was</td>
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;text-align:right;">Now</td>
            <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;text-align:right;">Change</td>
          </tr>
          ${changeRows}
        </table>
      </td></tr>`;
  }

  // --- Category Tables ---
  let categoryHtml = '';
  for (const cat of categoryRows) {
    let compRows = '';
    for (const c of cat.competitors) {
      compRows += `
        <tr>
          <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#444;">${c.name}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;color:#333;">${c.product || ''}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;font-size:13px;text-align:right;color:#333;font-weight:500;">$${Math.round(c.priceUsd)}</td>
          <td style="padding:6px 10px;border-bottom:1px solid #f0f0f0;text-align:right;">${diffBadge(c.diff)}</td>
        </tr>`;
    }

    const avg = cat.avgCompetitor;
    const rubiesVsAvg = avg ? Math.round(((cat.rubiesPrice - avg) / avg) * 100) : null;

    categoryHtml += `
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;border-collapse:collapse;">
        <tr>
          <td colspan="4" style="padding:10px;background:#faf5f8;border-left:3px solid #A8005C;border-radius:2px;">
            <span style="font-size:14px;font-weight:700;color:#A8005C;text-transform:uppercase;letter-spacing:0.5px;">${cat.label}</span>
            <span style="float:right;font-size:13px;color:#333;">RUBIES <strong>${cat.rubiesProduct}</strong> <span style="background:#A8005C;color:#fff;padding:2px 8px;border-radius:3px;font-weight:700;font-size:13px;">$${cat.rubiesPrice}</span></span>
          </td>
        </tr>
        <tr style="background:#f9f9f9;">
          <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;">Brand</td>
          <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;">Product</td>
          <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;text-align:right;">USD</td>
          <td style="padding:5px 10px;font-size:11px;font-weight:600;color:#888;text-transform:uppercase;text-align:right;">vs RUBIES</td>
        </tr>
        ${compRows}
        ${avg ? `<tr style="background:#f9f9f9;">
          <td colspan="2" style="padding:7px 10px;font-size:12px;font-weight:700;color:#666;">AVG COMPETITOR</td>
          <td style="padding:7px 10px;text-align:right;font-size:13px;font-weight:700;color:#333;">$${avg}</td>
          <td style="padding:7px 10px;text-align:right;font-size:12px;font-weight:600;color:${rubiesVsAvg < 0 ? '#0a7c42' : '#c0392b'};">${rubiesVsAvg > 0 ? '+' : ''}${rubiesVsAvg}%</td>
        </tr>` : ''}
      </table>`;
  }

  // --- Errors ---
  let errorsHtml = '';
  if (errors && errors.length > 0) {
    const errList = errors.map((e) => `${e.competitor} (${e.category}): ${e.error}`).join('<br>');
    errorsHtml = `
      <tr><td style="padding:0 20px 16px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:10px;background:#fff8e1;border-left:3px solid #f9a825;border-radius:2px;font-size:12px;color:#666;">
            <strong style="color:#f57f17;">Scrape Issues:</strong><br>${errList}
          </td></tr>
        </table>
      </td></tr>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Georgia,'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:20px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:4px;overflow:hidden;max-width:600px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#A8005C;padding:24px 20px 20px;">
          <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.7);font-family:Helvetica,Arial,sans-serif;">Monthly Report</p>
          <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#fff;font-family:Georgia,serif;">Competitor Price Monitor</h1>
          <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85);font-family:Helvetica,Arial,sans-serif;">${month}</p>
        </td></tr>

        <!-- Summary Bar -->
        <tr><td style="padding:0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td width="50%" style="padding:18px 20px;background:#faf5f8;border-bottom:1px solid #f0e0ea;">
                <p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-family:Helvetica,Arial,sans-serif;">RUBIES Avg</p>
                <p style="margin:0;font-size:26px;font-weight:700;color:#A8005C;font-family:Georgia,serif;">$${overall.rubiesAvg}</p>
              </td>
              <td width="50%" style="padding:18px 20px;background:#f5f5f5;border-bottom:1px solid #eee;">
                <p style="margin:0 0 2px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#999;font-family:Helvetica,Arial,sans-serif;">Competitor Avg</p>
                <p style="margin:0;font-size:26px;font-weight:700;color:#333;font-family:Georgia,serif;">$${overall.competitorAvg}</p>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding:12px 20px;background:${overall.diff < 0 ? '#e8f8ef' : '#fdecea'};text-align:center;">
                <span style="font-size:14px;font-weight:700;color:${overall.diff < 0 ? '#0a7c42' : '#c0392b'};font-family:Helvetica,Arial,sans-serif;">RUBIES is ${Math.abs(Math.round(((overall.diff) / overall.competitorAvg) * 100))}% ${overall.diff < 0 ? 'below' : 'above'} competitor average</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Price Changes (first, if any) -->
        ${changesHtml}

        <!-- Full Category Breakdown -->
        <tr><td style="padding:20px 20px 0;">
          ${categoryHtml}
        </td></tr>

        <!-- Errors -->
        ${errorsHtml}

        <!-- Sheet Link + Footer -->
        <tr><td style="padding:16px 20px;border-top:1px solid #eee;">
          <p style="margin:0;font-size:13px;color:#666;font-family:Helvetica,Arial,sans-serif;">Full comparison: <a href="https://docs.google.com/spreadsheets/d/1JHry_C9qCUrBlXQdUOqnC34gDPgcfSDCw0LtfKyhN5U" style="color:#A8005C;font-weight:600;">Open Google Sheet</a></p>
        </td></tr>
        <tr><td style="padding:12px 20px;border-top:1px solid #eee;">
          <p style="margin:0;font-size:11px;color:#888;line-height:1.5;font-family:Helvetica,Arial,sans-serif;"><strong style="color:#666;">Methodology:</strong> RUBIES prices use the adult tier (max variant) pulled live from rubyshines.com. Competitor prices use each store's base currency (no Shopify Markets pad), converted to USD at today's market FX rate. Price changes are flagged only when the merchant's own local-currency price moves &mdash; FX wobble alone does not trigger a change.</p>
        </td></tr>
        <tr><td style="padding:12px 20px;border-top:1px solid #eee;text-align:center;">
          <p style="margin:0;font-size:11px;color:#bbb;font-family:Helvetica,Arial,sans-serif;">Generated by RUBIES Automations &middot; ${date}</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function diffBadge(diff) {
  if (!diff && diff !== 0) return '<span style="color:#999;">—</span>';
  const isMore = diff > 0;
  const color = isMore ? '#c0392b' : diff === 0 ? '#666' : '#0a7c42';
  const bg = isMore ? '#fdecea' : diff === 0 ? '#f5f5f5' : '#e8f8ef';
  const sign = diff > 0 ? '+' : '';
  return `<span style="display:inline-block;padding:2px 7px;border-radius:3px;background:${bg};color:${color};font-weight:600;font-size:13px;">$${sign}${diff}</span>`;
}

module.exports = { buildEmail };
