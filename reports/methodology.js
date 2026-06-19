/**
 * methodology.js — writes "how-it-works.html", a plain-language companion to the
 * email report. Explains for a non-technical reader (Sadie) what was built, how
 * the data flows from Klaviyo into Supabase into the report and AI tools, how to
 * read each section, and the methodology behind the numbers. Anchored so the
 * report's per-section "Methodology" links deep-link here.
 */
const fs = require('fs');
const path = require('path');

const B = { orange: '#EE5A24', navy: '#1B2541', magenta: '#E6007E', ink: '#241a16', muted: '#8a7d74', line: '#ece3d8', cream: '#FBF6EF', card: '#fff' };

// Data-flow diagram (inline SVG): sources -> sync -> database -> outputs.
function diagram() {
  const box = (x, y, w, h, fill, stroke, title, sub) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>
     <text x="${x + w / 2}" y="${y + (sub ? 26 : h / 2 + 5)}" text-anchor="middle" font-size="15" font-weight="700" fill="${stroke === '#fff' ? '#fff' : B.ink}" font-family="'Fraunces',serif">${title}</text>
     ${sub ? `<text x="${x + w / 2}" y="${y + 46}" text-anchor="middle" font-size="11" fill="${stroke === '#fff' ? 'rgba(255,255,255,.85)' : B.muted}">${sub}</text>` : ''}`;
  const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${B.muted}" stroke-width="2" marker-end="url(#ar)"/>`;
  return `<svg viewBox="0 0 980 400" width="100%" font-family="'Hanken Grotesk',sans-serif">
    <defs><marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="${B.muted}"/></marker></defs>
    <text x="40" y="24" font-size="12" font-weight="700" fill="${B.muted}" letter-spacing="1">SOURCES</text>
    ${box(40, 36, 190, 58, '#fff', B.line, 'Klaviyo', 'campaigns, flows, subscribers, forms')}
    ${box(40, 104, 190, 58, '#fff', B.line, 'Shopify', 'orders (revenue), sessions (traffic)')}
    ${box(40, 172, 190, 58, '#fff', B.line, 'GA4', 'organic sessions, SEO')}
    ${arrow(230, 65, 330, 120)}${arrow(230, 133, 330, 130)}${arrow(230, 201, 330, 140)}
    ${box(330, 100, 150, 64, B.orange, '#fff', 'Daily sync', 'runs every day')}
    ${arrow(480, 132, 570, 132)}
    ${box(570, 94, 170, 76, B.navy, '#fff', 'Supabase', 'our own database, 5 yrs of history')}
    ${arrow(740, 118, 830, 78)}${arrow(740, 146, 830, 204)}
    ${box(830, 48, 150, 60, '#fff', B.line, 'This report', 'charts + takeaways')}
    ${box(830, 174, 150, 60, '#fff', B.line, 'AI tools', 'ideas, drafts, calendar')}
    <text x="40" y="280" font-size="12" font-weight="700" fill="${B.muted}" letter-spacing="1">WHAT HAPPENS</text>
    <text x="40" y="306" font-size="13" fill="${B.ink}">1. Every day we pull fresh numbers from Klaviyo, Shopify, and GA4 automatically (the "feeds").</text>
    <text x="40" y="330" font-size="13" fill="${B.ink}">2. They land in Supabase, our database, so the report is instant and makes (almost) no live calls.</text>
    <text x="40" y="354" font-size="13" fill="${B.ink}">3. The report reads only from Supabase and Opus (the AI) writes the analysis. The same data powers the AI tools.</text>
    <text x="40" y="384" font-size="12" fill="${B.muted}">Note: the report uses Shopify for total store sessions (GA4's are organic-only). GA4 mainly powers SEO.</text>
  </svg>`;
}

const sectionsHTML = `
<section id="architecture">
  <h2>How the whole thing fits together</h2>
  <p>You do not need to touch any of this plumbing. It runs on its own. Here is the picture so you know where the numbers come from.</p>
  <div class="diagram">${diagram()}</div>
  <p class="note">In plain terms: Klaviyo and Shopify are where the activity happens. Every night a small program copies the latest numbers into our own database (Supabase). The report and the AI tools both read from that database, which is why a full report builds in seconds instead of waiting on slow downloads.</p>
</section>

<section id="data">
  <h2>Where the numbers come from</h2>
  <ul>
    <li><b>Campaigns</b> (one-off sends): from Klaviyo, going back to 2021.</li>
    <li><b>Flows</b> (automated emails like Welcome and Abandoned Cart): from Klaviyo, going back to 2021.</li>
    <li><b>Store revenue</b>: the real Shopify order totals, synced into Supabase. (This is the actual money the store made, used as the denominator for "what share came from email".)</li>
    <li><b>Subscribers, list sizes, and pop-up forms</b>: a daily feed (<code>klaviyo_audience_daily</code>) records new/lost subscribers, form views and submits, and a snapshot of the list size.</li>
    <li><b>Store sessions (traffic)</b>: a daily feed (<code>shopify_sessions_daily</code>) records total online-store sessions, used for the signup conversion rate.</li>
  </ul>
  <p class="note">Everything the report reads is already saved in Supabase by these daily feeds, so a full report builds in seconds and makes (almost) no live calls. The feeds run automatically each day with the rest of the sync.</p>
  <p>The report is organized into five parts, matching the things you actually manage: <b>Overview</b> (whole-program health), <b>Lists</b> (your audience, the biggest lever), <b>Campaigns</b> (one-off sends), <b>Flows</b> (automations), and <b>Strategy</b> (takeaways and the Playbook). Each of Lists, Campaigns, and Flows ends with its own <b>strategies</b> block, pulled from the Playbook.</p>
</section>

<section id="comparison">
  <h2>Period Comparison</h2>
  <p>Shows this period next to two reference points so a number always has context:</p>
  <ul>
    <li><b>Previous period</b>: the same number of months right before this one.</li>
    <li><b>Year ago</b>: the same calendar months one year earlier (this is what "YoY", year over year, means).</li>
  </ul>
  <p>A green <b style="color:#1f9d63">▲</b> means up versus that column, a red <b style="color:#d6492f">▼</b> means down.</p>
</section>

<section id="momentum">
  <h2>Momentum (last 30 / 90 days)</h2>
  <p>A quick read on recent performance. Each arrow compares the last 30 (or 90) days to the exact same window one year earlier, so seasonality is fair.</p>
</section>

<section id="revenue">
  <h2>Revenue Over Time</h2>
  <p>Each bar is total store revenue for a month, split into the part attributed to <b style="color:#EE5A24">campaigns</b>, the part attributed to <b style="color:#1B2541">flows</b>, and other sales. The number on top is the month total. The small colored % is the change versus the same month a year earlier.</p>
  <p class="note"><b>Attribution rule:</b> each order is credited to the single campaign or flow the buyer last engaged with (Klaviyo's last-touch model). So no order is ever counted in two places, and campaigns + flows + other add up exactly to store revenue. One thing to keep in mind: "attributed" means the buyer had a recent email touch, not that email is what caused the sale. So it is a useful share for trends, not a measure of incremental lift (that would need a holdout test).</p>
</section>

<section id="funnel">
  <h2>Engagement Funnel</h2>
  <p>Follows people through the journey: delivered, then opened, then clicked, then converted. Each stage shows the count, its share of everyone delivered, and the drop from the stage right above it.</p>
</section>

<section id="growth">
  <h2>Audience Growth (the biggest lever)</h2>
  <p>The list gets its own section near the top because growing it is the single biggest revenue lever. It pulls together four things:</p>
  <ul>
    <li><b>Value of a subscriber</b>: we divide email-attributed revenue over the last year by the number of subscribers, so every growth number has a dollar value. (Currently each email subscriber is worth roughly $30 a year, so +1,000 subscribers is about +$30,000 a year, compounding.)</li>
    <li><b>Scorecard</b>: list size, growth over 1 year / 90 days / 30 days, annual churn, and a health read (on-track, below-target, or under-scaled).</li>
    <li><b>Growth charts</b>: the orange area is the total subscriber count over time (anchored to the live Newsletter / SMS Subscribers list size and walked backward by each month's net change, so older months are estimates). Green bars below are new subscribers each month, red bars are people who left.</li>
    <li><b>Capture funnel</b>: how the website pop-up is doing (views, submissions, submit rate), plus the <b>signup conversion rate</b> (new subscribers divided by total store sessions). Form-view tracking only began recording properly in late 2025, so earlier year-over-year form comparisons show as n/a.</li>
    <li><b>List growth strategies</b>: the recommendations for growing the list (scale SMS, fix the pop-up, capture levers) live right here, pulled from the Playbook. This is where to look for "what to do about it".</li>
  </ul>
  <p class="note">Percentage growth matters more than raw adds: as a list gets bigger, the same number of new subscribers is a smaller percentage, so the rate tells you if growth is keeping pace.</p>
</section>

<section id="campaigns">
  <h2>Campaigns: Performance &amp; strategies</h2>
  <p>Every send in the period, with open rate, click rate, unsubscribe rate, and revenue. The colors are a heat map: greener is better, redder is worse, within that month. Unsubscribe and bounce are flipped (more is worse). A creative gallery shows the actual emails.</p>
  <p class="note">This part ends with <b>Campaign strategies</b>: durable priorities for one-off sends (subject lines, timing, content mix), pulled from the Playbook.</p>
</section>

<section id="flows">
  <h2>Flows: Top Flows &amp; strategies</h2>
  <p>Your automated emails ranked by revenue. Bar color shows the channel: <b style="color:#1B2541">email</b> or <b style="color:#E6007E">SMS</b>. "$/r" is revenue per recipient (a fairness measure, since a flow sent to few people can still be very valuable). The colored % is the change versus the same period last year.</p>
  <p class="note">This part ends with <b>Flow strategies</b>: which flows to build (back-in-stock, replenishment, sunset) and which to fix, pulled from the Playbook. Flow history is stored month by month in Supabase.</p>
</section>

<section id="takeaways">
  <h2>Takeaways, and how we judge a campaign</h2>
  <p>Opus reads the period and writes the takeaways. Crucially, it does not judge every email on revenue. It first works out <b>why</b> a send went out, then judges it on the right yardstick:</p>
  <ul>
    <li><b>Revenue</b> sends (sales, launches): judged on dollars.</li>
    <li><b>Product R&amp;D</b> sends (naming, fit-testing): judged on participation. These feed the development cycle and are timed to it.</li>
    <li><b>Community and brand</b> sends (stories, Pride): judged on engagement, not sales.</li>
    <li><b>List growth</b> sends: judged on new subscribers.</li>
    <li><b>Education</b> sends ("how it works"): judged on clicks and later purchases, not the same-day sale.</li>
  </ul>
  <p>So a "help us name this product" email with low revenue is correctly read as a success if it drove participation, not as a failure.</p>
</section>

<section id="playbook">
  <h2>Ground Truths &amp; Strategic Priorities (the Playbook)</h2>
  <p>The Playbook is a separate "ground truths" layer, computed over the full email history (5 years), with recent data weighted more so new products and new angles surface. It has two jobs:</p>
  <ul>
    <li><b>Ground Truths</b>: the durable patterns (which subject styles, send days, and seasons consistently work). The report's Takeaways are measured against these, and the AI campaign tools read them so their ideas reflect what has actually worked for RUBIES.</li>
    <li><b>Strategic Priorities</b>: the standing roadmap (which flows to build, how to grow the list). This lives in the Playbook, not in a single report, because it is a multi-month plan that evolves as things get shipped, not a one-time observation.</li>
  </ul>
  <p class="note">It is refreshed on demand (just ask Claude to "refresh the playbook"), not on every report, so it stays cheap. The numbers are computed exactly; one AI pass writes them up.</p>
</section>

<section id="tools">
  <h2>The AI tools you can use</h2>
  <p>You drive these by asking Claude in plain English. They are all grounded in what has actually worked for RUBIES, not generic advice.</p>
  <ul>
    <li><b>email_report</b> &mdash; build this whole report for any month or quarter. Example: "run the email report for Q4 2025".</li>
    <li><b>email_campaign_ideas</b> &mdash; campaign ideas grounded in real performance, each citing the data behind it.</li>
    <li><b>email_subject_lab</b> &mdash; subject line options ranked against your real open-rate history.</li>
    <li><b>email_campaign_draft</b> &mdash; full send-ready email copy in brand voice. It automatically pulls real customer reviews to quote.</li>
    <li><b>email_calendar_plan</b> &mdash; a dated send calendar that balances revenue, community, and education.</li>
    <li><b>find_review_quotes</b> &mdash; pulls real, relevant customer reviews to cherry-pick into a campaign.</li>
    <li><b>refresh_playbook</b> &mdash; rebuilds the ground-truths Playbook (above) over the full history. Run it after a launch or a new season.</li>
  </ul>
</section>

<section id="glossary">
  <h2>Quick glossary</h2>
  <dl>
    <dt>Campaign</dt><dd>A one-off email you send to a list (a sale, a launch, a story).</dd>
    <dt>Flow</dt><dd>An automated email triggered by behavior (Welcome, Abandoned Cart, Post Purchase). It runs on its own.</dd>
    <dt>Recipient</dt><dd>One person an email was sent to.</dd>
    <dt>Open / Click rate</dt><dd>Share of recipients who opened, or clicked a link.</dd>
    <dt>Conversion</dt><dd>A recipient who placed an order Klaviyo credits to that email.</dd>
    <dt>$/r (revenue per recipient)</dt><dd>Revenue divided by how many people got it. Fairly compares big and small sends.</dd>
    <dt>YoY (year over year)</dt><dd>Compared to the same time one year earlier.</dd>
    <dt>Attribution</dt><dd>Crediting a sale to the email the customer engaged with before buying.</dd>
  </dl>
</section>
`;

function writeMethodology(outDir) {
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RUBIES Email Reporting · How It Works</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:${B.cream};color:${B.ink};font-family:'Hanken Grotesk',-apple-system,sans-serif;line-height:1.6;
    background-image:radial-gradient(${B.line} .5px,transparent .5px);background-size:22px 22px;}
  .wrap{max-width:860px;margin:0 auto;padding:0 24px 80px;}
  .mast{padding:54px 0 26px;border-bottom:2px solid ${B.ink};}
  .mast .eyebrow{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:${B.orange};font-weight:700;}
  .mast h1{font-family:'Fraunces',serif;font-weight:600;font-size:50px;line-height:1;margin:14px 0 0;}
  .mast h1 em{font-style:italic;color:${B.orange};}
  .mast p{color:${B.muted};font-size:16px;margin:14px 0 0;}
  .back{display:inline-block;margin:22px 0 0;font-size:14px;color:${B.orange};text-decoration:none;font-weight:700;}
  section{background:${B.card};border:1px solid ${B.line};border-radius:18px;padding:26px 30px;margin:22px 0 0;scroll-margin-top:20px;}
  h2{font-family:'Fraunces',serif;font-weight:600;font-size:24px;margin:0 0 12px;}
  p{margin:0 0 12px;font-size:15px;}
  ul{margin:0 0 12px;padding-left:22px;font-size:15px;}
  li{margin:0 0 6px;}
  .note{font-size:13px;color:${B.muted};background:${B.cream};border-left:3px solid ${B.orange};padding:10px 14px;border-radius:0 8px 8px 0;}
  .caveat{font-size:14px;background:#fff7f3;border:1px solid ${B.line};border-left:3px solid ${B.magenta};padding:12px 14px;border-radius:0 8px 8px 0;}
  .diagram{margin:8px 0 16px;}
  dl{margin:0;font-size:15px;}
  dt{font-weight:800;color:${B.navy};margin-top:10px;}
  dd{margin:2px 0 0 0;color:${B.ink};}
  .toc{font-size:14px;columns:2;gap:24px;}
  .toc a{color:${B.navy};text-decoration:none;display:block;padding:3px 0;}
  .toc a:hover{color:${B.orange};}
</style></head>
<body><div class="wrap">
  <div class="mast">
    <div class="eyebrow">RUBIES · Email Reporting System</div>
    <h1>How It <em>Works</em></h1>
    <p>A plain-language guide to what we built, how the data flows, and how to read every part of the report. No technical background needed.</p>
    <a class="back" href="#" onclick="history.length>1&&history.back();return false;">&larr; Back to the report</a>
  </div>
  <section>
    <h2>On this page</h2>
    <div class="toc">
      <a href="#architecture">How it all fits together</a>
      <a href="#data">Where the numbers come from</a>
      <a href="#comparison"><b>Overview:</b> Period Comparison</a>
      <a href="#momentum">Overview: Momentum (30 / 90 days)</a>
      <a href="#revenue">Overview: Revenue Over Time</a>
      <a href="#funnel">Overview: Engagement Funnel</a>
      <a href="#growth"><b>Lists:</b> Audience Growth &amp; strategies</a>
      <a href="#campaigns"><b>Campaigns:</b> Performance &amp; strategies</a>
      <a href="#flows"><b>Flows:</b> Top Flows &amp; strategies</a>
      <a href="#takeaways"><b>Strategy:</b> Takeaways &amp; how we judge</a>
      <a href="#playbook">Strategy: Ground Truths &amp; the Playbook</a>
      <a href="#tools">The AI tools</a>
      <a href="#glossary">Glossary</a>
    </div>
  </section>
  ${sectionsHTML}
  <div class="foot" style="color:${B.muted};font-size:12px;padding:28px 0 0;">RUBIES email reporting. Built with Claude. Data from Klaviyo and Shopify, stored in Supabase.</div>
</div></body></html>`;
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'how-it-works.html');
  fs.writeFileSync(outPath, html);
  return outPath;
}

module.exports = { writeMethodology };
