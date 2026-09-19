# Virtual Closet: stage 1 review

Test pass over the stage 1 wireframes (export of 2026-09-18, turns 1 and 2), read against the design brief, the programme record and the live store. Two parts. Part 1 is what the flow gets wrong and how to fix it. Part 2 is the copy, rewritten, for every email and for the on-screen lines that change. Written as the record of the review. The app (`virtual-closet/`) was built from these wireframes the same day; every finding below was applied to the app on 2026-09-18, and the copy in Part 2 is what the app now says. Claude Design's stage 2 should take its copy from the app, not from the stage 1 export.

Rule for Part 2: copy is what a person reads on the screen or in the email. Anything about how the thing is built (which platform enforces what, which step is required before which, what the designer intended) is a grey note or nothing. Several of those had drifted into the copy itself; they are gone below.

---

## Part 1: findings

Ordered by how much they change. Screen ids are the wireframe labels.

### 1. The size run is wrong for four of the five styles

Only Sassy runs XXS to 4X in letters. AJ, Charlie, Brooke and Ruby run 4, 6, 8, 10, 12, 14, 16, then L, 1X, 2X, 3X. On those four, youth 12 is adult XS, 14 is S, 16 is M. There is no size called XL anywhere on the store; XL is the warehouse spelling of 1X.

- 1a, 1j, 1w size chips: drop XL. The adult run reads XS, S, M, L, 1X, 2X, 3X, 4X, plus kids. A centre picking S is saying "14 on AJ, Charlie, Brooke and Ruby; S on Sassy". The store's own size guide carries the equivalence; the centre never sees it.
- 1g, 1o size picker: per style, in that style's own run, filtered to what the centre offers.
- 1x, 2g packing grids: drop the XL column; each style row uses its own run.
- 1ah size sheet and 1g "Measure your hips": hips for underwear and bikini bottoms, chest where the band sits for the Brooke bra. Reuse the store size guide as drawn; just don't say hips for a bra.

### 2. "Funded" and "sent" are one state on the public page; they are two

1c says "Ships when it's funded" and 1f moves from "Fully funded" straight to "Being packed at RUBIES". The centre decides at the goal: send now or keep growing. So the public progress module needs one more state, and one line changes:

- Nothing raised yet, In progress, Goal grown by requests: as drawn.
- Funded, still open (new): "Funded. [Centre name] decides when it ships; everything given now goes in too." Sponsor button stays "Sponsor the closet".
- Sent, being packed (was "Fully funded"): "On its way to being packed at RUBIES. New sponsorships start shipment [#3]."
- Delivered, new shipment open: as drawn.
- 1c strip: replace "Ships when it's funded" with "Ships when [Centre name] sends it", or drop the line.

### 3. Decide where a request goes when the box is funded but not yet sent

The "box is funded" email (1aa) says new requests wait for box #3. Settings (1w), Home (1v) and the programme record say the goal grows to cover everyone approved. Both can't be true. Recommendation: while a box is open, requests join it and the goal grows with them; the wait list starts the moment the centre taps Send. Then:

- 1aa funded email: drop "New requests now wait for box [#3] until you send this one."
- 1f: the "your request joins the next one" request copy applies only from Send onward.

### 4. The decline email contradicts the decline dialog

2d: a declined request does not use up a turn unless the centre ticks the box. The decline email (1ac, and the preview in 2d) says "You're welcome to request again from [date]". Default email has no date; the date line appears only when the centre ticked "count this toward their limit". Copy in Part 2.

### 5. Unverified centres appear in the operator queue but should never reach it

1r: RUBIES is only told about a new centre once the admin's email is verified. 2e: Centre E is in the queue "not yet verified", with Approve disabled. Pick one. Recommendation: keep 1r, drop Centre E's row and the disabled Approve state. A sign-up that never verifies is noise, not a queue item.

### 6. The welcome email states things that are only sometimes true

"At $[300] we email you to send it": the goal is the centre's own and grows. Say "at your goal". "You're on the donation map": only if they ticked [Pass It On]. Make that line conditional.

### 7. Audience words slipped: sponsors and requesters are shown "box"

Community-facing copy says shipment. 1ad: "The box you sponsored", "Start the next box". 1g Before you send: "what happens if a box is delayed". All become shipment.

### 8. Sponsor thank-you ties the money to requesters

1ad: "[about three] pairs for people in [city] who requested them". Sponsor money is for the closet, not for named people (1ad's own note says so). "who need them".

### 9. A build note is in the customer terms

1ah, Offer details row: "(by store account or email; depends on what the store platform can enforce)". The page states the rule: once per customer. What enforces it is a build question.

### 10. The Pre-Loved name

The brief asked for a placeholder; Claude Design chose "Pass It On" and Jamie kept it (build answers, 2026-09-18). Settled, no change.

### 11. Brand facts

- "tuck-friendly" (1a About, 1j): RUBIES is no-tuck. Never tuck-friendly.
- 1ah AJ sheet: "gaff-style shaping". Never gaff or compression language. "Smooth, feminine shaping, no tucking."
- "Nude" is not a colourway; the store calls it Sandstone.
- Product names on cards should match the store exactly: AJ NO-TUCK SHAPING UNDERWEAR, CHARLIE NO-TUCK EXTRA CUTE SHAPING UNDERWEAR, SASSY NO-TUCK SHAPING UNDERWEAR, BROOKE SHAPING BRA, RUBY NO-TUCK SHAPING BIKINI BOTTOM. Prices as briefed are the adult prices; youth sizes on AJ, Charlie, Brooke and Ruby are a few dollars less, which only matters to the packing totals.
- "first name only" (2g packing bags) and "list of first names" (1af, 14 days): "the name they go by". Nobody on this programme has a first name we know.

### 12. Mechanics shown to the wrong audience

- 2a hero: "Approved within the limits [Centre name] sets." Requesters hear timing only. Drop it; "Only RUBIES and [Centre name] see your request" stays.
- 1g Before you send: "Any age." and the centre-leaves line belong on the Free pair terms page, not the form. (The requester does get one email if it ever happens; copy in Part 2.)

### 13. Build-time and meta lines inside on-screen copy

These are the ones that read like notes to the developer or narrate the system to the person. All rewritten in Part 2:

- 1r: "Any address works; we'll ask you to verify it."
- 1ab verify email: "Required: one tap to finish setting up [Centre name]. Nothing works until you do."
- 1x requested items: "Fixed."
- 1aa: "This is the approval email from the brief." sits inside the email card, not in a grey note.
- 1g under Send: "First time requesting with this email? ... Confirmed before? Your request goes straight in." The person doesn't need the rule explained; one line.
- 1v banner: "when a person at RUBIES has said hello".
- 1a step 2 title: "We say hello".
- 1x default delivery note repeats what RUBIES' own email already says (plain packaging, tracking). The centre's note should sound like the centre.

### 14. Settled: one order per customer

Jamie confirmed on 2026-09-18: the 20% is for one order per customer, existing customers included, and so is the closet's credit. The copy's "one order" stands everywhere. The initiative file and programme record now say the same.

---

## Part 2: copy

Voice: short, warm, plain. RUBIES is a small brand talking to a centre it likes and to a person it wants to look after. No em dashes. Matching, never discount or doubled, anywhere a centre or sponsor reads. Shipment for the community, box for the centre. Placeholders stay in brackets.

### Emails to the RUBIES operator

**Subject: New centre: [Centre name], [city]**
[Centre name], [city] · [website]
Ticked: Virtual Closet, [Pass It On]
Sizes: XS to 4X, kids
Admin: [name], [role], [email] (centre address)
[Approve] [Ask for more] [Decline]

**Subject: Needs attention: [3] things**
[Centre A]: [5] requests waiting for the next box · Open
[Centre B]: orders jumped to [40] this week · Open
[Centre C] signed up [6] days ago, not yet reviewed · Open
[Centre D] hasn't answered a request in [4] days · Open

### Emails to the centre: programme

**Subject: Your closet is open, [Centre name]**
Hi [name],

[Centre name]'s closet is live. Keep this email; it has everything the next person running the closet will need.

**Your link:** rubyshines.com/closet/[slug]
Everyone who opens it gets 20% off one order, and every two items bought put one in your closet. Share it on your site, your socials, your noticeboard. A ready-made post and a QR code are waiting in your private view.

**How it works.** Shopping, requesting and sponsoring all go into one box, and RUBIES matches every dollar in it. Requests are approved automatically within the limits you set. When the box reaches your goal, we email you to send it. It arrives at [address] with everyone's requested items inside.

**Your settings:** sizes [XS to 4X, kids] · [2] items per request · [2] requests a person a year · goal $[300] · automatic approval · shipping to a door on. Change any of these.

[If Pass It On:] You're on the donation map too, with your pin linked to your closet.

Worth passing on: How RUBIES works · Our styles · Size guide · Free pair terms

[Open your private view]

Questions, any time: Jamie, [email]. Or book a call.

**Subject: Someone sponsored [Centre name]'s closet**
A sponsor just put $[50] into box [#2]. RUBIES matches it when the box ships.
Box [#2]: $[190] raised of $[300]
[See the box]

**Subject: A request for your closet** (by-hand approval)
Rosa asked for AJ · Black · 1X and Brooke bra · Pink · 1X, to pick up at the centre.
"[Their words]"
[Approve] [Decline]
One tap, no sign-in. These links work for [X] days; after that, answer from your private view.

**Subject: A request joined box [#2]** (automatic approval)
Rosa asked for [2] items and was approved within your limits. Box [#2] now has [4] requests.
[See them]

**Subject: Box [#2] is funded**
You've reached $[300]. RUBIES matches it when the box ships.
Everyone's requested items are already in. Choose the rest yourself, or let us fill it across your sizes.
[Fill and send the box] [Keep it growing]

**Subject: Box [#2] is on its way**
[N] items are heading to [address], arriving around [date].
[Carrier] [tracking]
Inside: requests from Rosa and Dee, plus [N] more items across your sizes. Mel's items are going straight to their door.
[Packing list]
Box [#3] is open at $0 of $[300].

**Subject: [Centre name]'s closet in [Month]**
Link visits [212] · Orders from your link [9] · Into the box $[124] · Requests [4]
Box [#2]: $[140] raised of $[300]
[Pass It On]: [2] customers were given your address for returned items.
[Open your private view]

**Subject: Something's on its way to your closet** ([Pass It On], if kept as its own email)
A customer has been given your address to send [2] returned RUBIES items. We can't see when it lands, so keep an eye out.

### Emails to the centre: account

**Subject: Confirm your email for [Centre name]**
One tap and [Centre name]'s account is ready.
[Confirm my email]
The link works for [X] hours.

**Subject: Reset your password**
[Choose a new password]
The link works for [X] hours. Didn't ask for this? Ignore it and nothing changes.

**Subject: [Jamie] invited you to [Centre name]'s closet**
Join the team that runs [Centre name]'s closet: see requests, send boxes, share the link.
[Accept]
The invitation expires [date].

**Subject: You're on [Centre name]'s team**
[Jamie] added you as a member.
[Open your private view]

**Subject: You're now an admin of [Centre name]**
[Jamie] handed admin to you. You can change settings, invite people and leave the programme.
[Open your private view]

**Subject: Your email was changed**
Your [Centre name] account now uses [new]. Wasn't you? [Tell us]

### Emails to a requester

Subjects never name the items. Sender is RUBIES, plain.

**Subject: One tap to send your request**
Hi Rosa, tap below and your request for AJ · Black · 1X and Brooke bra · Pink · 1X goes to [Centre name].
[Confirm my request]
The link works for [X] hours. Didn't ask for this? Ignore it and nothing happens.
Free pair terms · Size guide

**Subject: Got your request, Rosa**
You asked for AJ · Black · 1X and Brooke bra · Pink · 1X, to pick up at [Centre name]. It's in.
It comes with the closet's next shipment, and we'll email you when it's ready.
Free pairs are final. If your colour runs out, we send the same style in another colour.
[Centre name]'s closet

**Subject: You're on the list, Rosa**
This shipment is already funded and being packed, so yours goes in the next one. We'll write again when it's on its way. Nothing to do for now.

**Subject: On their way to [Centre name]** (pickup, when the centre sends the box)
Your items are in [Centre name]'s shipment, being packed at RUBIES now. We'll email you the moment they're ready to collect.

**Subject: Ready for you at [Centre name]** (pickup, when the carrier reports delivery)
Your AJ · Black · 1X and Brooke bra · Pink · 1X are ready.
From [Centre name]: [pickup note]

**Subject: Still waiting for you at [Centre name]** (reminder, 14 days)
Your AJ · Black · 1X and Brooke bra · Pink · 1X are still at the closet, whenever you're ready.
From [Centre name]: [pickup note]

**Subject: On its way to you** (delivery, when the centre sends the box)
Your Sassy · Mint · M is being packed at RUBIES and will come straight to you in plain packaging.
From [Centre name]: [delivery note]
A shipping confirmation with tracking follows when it leaves, usually within a few days.

**Subject: About your request** (declined)
Hi Rosa, [Centre name] wasn't able to approve this request. If you'd like to talk it through, drop by the centre and ask for someone who runs the closet.
[Only if the centre ticked "count this toward their limit":] You can request again from [date].

**Subject: About your request** (centre left the programme before it shipped)
Hi Rosa, [Centre name] has left the closet programme, so your request has ended with them. We're sorry. Other centres near you are on the map, and you can request there.

### Emails to a sponsor

**Subject: Thank you from [Centre name]'s closet**
Your $[50] went into [Centre name]'s shipment, and RUBIES matched it. That's about [three] pairs for people in [city] who need them.
Shipment [#2]: $[190] raised of $[300]
[Centre name]'s closet

**Subject: It arrived**
The shipment you sponsored reached [Centre name] today: [38] items, [3] of them for people who requested. Thank you for being part of it.
[Start the next shipment]

### On-screen lines that change

Only the lines that change. Everything not listed stays as drawn.

**1a programme page**
- About RUBIES: "RUBIES is a small brand making gender-affirming underwear and swimwear for trans girls and women. No tucking, no compression, just a smooth line in something that feels like regular underwear. Every girl deserves to shine."
- How it works, step 2: title "We approve you". Body "A person at RUBIES reviews every new centre, usually within a few days."
- Sizes chips: XS S M L 1X 2X 3X 4X · Kids sizes.

**1b, 1k confirmation**
"Thanks, [Centre name]. You're in the queue. A person at RUBIES reviews every new centre, usually within a few days. Your closet page goes live the moment we approve you, and we'll email you your link and everything to share."

**1c closet, progress strip**
"Ships when [Centre name] sends it" (replaces "Ships when it's funded").

**1f states**
- Funded, still open: "Funded. [Centre name] decides when it ships; everything given now goes in too."
- Sent, being packed: "On its way to being packed at RUBIES. New sponsorships start shipment [#3]."

**2a request-first hero**
Under the buttons: "Only RUBIES and [Centre name] see your request." (the limits sentence goes)

**1g, 1o request form**
- Size box: "Check your size first. Free pairs can't be exchanged, so a minute with the size guide is worth it. Hips for underwear and bikini bottoms, chest for the bra."
- Before you send:
  · Free pairs are final: no exchanges or returns, so check the size guide.
  · Colour is a preference. If yours runs out, you get the same style in another colour.
  · Up to [2] items per request, [2] requests a year at [Centre name].
  · Your address stays with RUBIES. [Centre name] sees only the name you go by, your items and your words.
  Everything else, including delivery times: Free pair terms. By sending you agree to them.
- Under Send my request: "We'll email you a link to confirm it's you. Nothing goes to [Centre name] until you tap it."

**1h, 1p after sending**
"One more step, [name]. We sent a link to [email]. Tap it and your request goes to [Centre name]."

**1r create account**
- Under the button: "By continuing you agree to [terms]. We'll send a link to confirm your email."
- Verify page: "We sent a link to [email]. Open it to finish setting up [Centre name]'s account. Didn't get it? Send again · Change address"

**1v home, waiting banner**
"Waiting for approval. A person at RUBIES reviews every new centre, usually within a few days. Your page goes live the moment we do."

**1w settings, words**
"Nothing appears on your page until an admin publishes it. Unpublish any time."

**1x send the box**
- Under requested items: "These are set. If a colour runs out, RUBIES sends the same style in another colour and the box pays that item's price."
- Step 4: "A note to the people who requested. Goes out with their emails: pickups get the first note the day the carrier delivers the box to you, deliveries get the second one now."
- Default pickup note: as drawn.
- Default delivery note: "From everyone at [Centre name]: enjoy them. If you ever need anything else, you know where we are."

**2g packing list**
"bag separately, label with the name they go by"

**1af, 14 days**
"Not collected yet?" list shows the names they go by.

**1ah terms table, Offer details row**
"20% off one order with RUBIES from this link, new or returning. Once per customer. 30 days from the link. Not combinable. Excludes [gift cards]. Orders count for the closet for 30 days."

**1ah AJ sheet**
"What it does: smooth, feminine shaping with no tucking. Fabric: [ ]. Fit: [ ]. Colours: Black, Pink."

**Everywhere**
- [Pass It On] in brackets.
- "shipment" wherever a requester or sponsor reads: 1ad both emails, 1g Before you send.
- "tuck-friendly" → "no-tuck". "Nude" → "Sandstone". "first name" → "the name they go by".
