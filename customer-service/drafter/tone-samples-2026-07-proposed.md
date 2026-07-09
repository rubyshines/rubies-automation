# Proposed tone-sample refresh — July 2026

Curated from Jamie's June–July sends (his rewrites of edited drafts + drafts sent
byte-identical). Replaces the March 2026 set (51 samples, extracted 2026-03-21,
pre-dating the terser June register and skewed to sizing/empathy/closing — zero
samples for action confirmations, the highest-volume scenario).

Review: mark keep/kill per row, then the approved rows replace the `active` set in
`cs_tone_samples` (old rows flipped `active=false` for rollback — no deletes).
Names are genericized to [Name]; discount codes to [CODE]. Obvious typos in the
originals were left intact where they don't teach a mistake, cleaned where they do
(flagged ✎).

## Action confirmations (new category — was missing entirely)

| # | situation | sample (Jamie verbatim) | source |
|---|---|---|---|
| 1 | order_edit_confirm | "I swapped the Mia top from Pink to Black in size 12." | draft 2187 ✎ ("I' swapped") |
| 2 | address_fix_confirm | "Sorry not sure what happened but I have corrected the address." | draft 1682 |
| 3 | quick_refund_confirm | "No problem I sent over a refund for the extra pair." | draft 1569 |
| 4 | order_update_confirm | "Yes! I was going to follow up to let you know that! I have updated your order." | draft 1489 |
| 5 | profile_update_confirm | "I've updated your account name to [Name] and changed your email to [email]. Congrats again!" | draft 2070 |
| 6 | split_shipment_confirm | "I've split your shipment so the [in-stock items] will ship now. The [held item] will follow once it's back in stock. You'll get separate tracking for each. Thanks for your patience with this." | draft 1394 |
| 7 | refund_with_donation | "Ok, since you've already got the right size, I've processed your refund to your original payment method. You'll get a confirmation email with the details. No need to send anything back to us. You're welcome to donate the size 8 to a local LGBTQ+ organization if you'd like." | draft 2046 |
| 8 | refund_donate_all_model | "No problem. I sent over a refund. We have moved to a model where all RUBIES returns will be donated. Since you only have one item to return, feel free to donate it locally. If you don't have someone or a local org in mind, I can send you the info for one of our partner LGBTQ+ organizations that accept donations for distribution in their gender affirming clothing programs." | draft 1488 |

## Refund nudges & clarifications

| # | situation | sample | source |
|---|---|---|---|
| 9 | refund_probe_first | "Before we do a refund, can you let me know what didn't work out with the fit in case I can help you with another size or recommend another product?" | draft 2299 |
| 10 | refund_probe_alt | "Sorry these didn't work out. Before I set up a return, can you tell me a bit about the fit, were they too big, too small, or off in another way, in case I can help with another size or a different product?" | draft 2363 |
| 11 | refund_or_exchange_choice | "No problem. Are you interested in exchanging for anything else in our catalog or just go for the refund on those two items?" | draft 2406 |
| 12 | refund_scope_clarify | "Thanks for your kind words! No problem returning the suits but I just wanted to clarify are you returning both or only one size as you had indicated returning both of them." | draft 1849 |

## Exchange scope confirms

| # | situation | sample | source |
|---|---|---|---|
| 13 | exchange_scope_confirm | "Just to confirm, are you looking to exchange all four items (both AJ and both Brooke) from a 4X down to a 3X?" | draft 1972 |
| 14 | exchange_scope_short | "Are you looking to exchange all of the AJs for size 12?" | draft 2092 |

## Sizing protocol & recommendations

| # | situation | sample | source |
|---|---|---|---|
| 15 | measurement_request | "Can you send me her waist measurement around the belly and just under the belly button, plus her chest measurement around where a bikini band sits? Once I have those I can double check the right size for her." | draft 2063 |
| 16 | onepiece_measurement_detail | "About an inch under the belly button. No chest measurement needed for the one-piece, just the waist measurements and her height. Once I have those I can double check size 13 is still right." | draft 1393 |
| 17 | size_options_delta | "The size 6 will have 2\" more fabric around the waist than the 4 you have, and the size 7 will have 3\" more. Which one sounds like a better fit?" | draft 2254 |
| 18 | decisive_size_rec | "Ok I would recommend the tall version so a size 16 Tall." | draft 1485 |
| 19 | decisive_from_measurement | "For a 29 inch chest, the Queeny tankini in size XS is the best fit for your daughter. Would you like me to help with the bikini bottoms too, or are you all set there?" | draft 2334 |
| 20 | sizing_flexibility | "Size 11 is still right for the waist, and for the length it should sit comfortably. If you want to size down to a 10 that should be fine. You can always exchange if it doesn't work on the first try." | draft 2212 |
| 21 | twopiece_split_sizing | "For the two piece, the sizes come out a little different on top and bottom. Based on her chest of 29\", the bikini top would be a size 12, and based on her waist of 31.5\", the bottom would be a size 16 (though if you think the 14 one-piece fits fine on the bottoms you could size down). It's totally normal for the top and bottom to be different sizes." | draft 1494 |
| 22 | chart_standard_sizing | "Our underwear follows standard US womens sizing, the same as any other clothing brand. Our bottoms work best worn comfortably, not too tight or too loose, so they can do their job. It's possible your other bottoms are sized smaller as they are being worn tighter. I'd go with what the chart recommends for your measurement. It works for most people, though there can be exceptions, and if it doesn't feel right when it arrives we offer free exchanges." | draft 2128 |
| 23 | above_chart_honest | "I am sorry to say but I believe these are going to be too tight in our swimwear. You could try a single pair of our AJ underwear in a 4X size if you are looking for something with more stretch for everyday. That might work." | draft 1698 |

## Shipping

| # | situation | sample | source |
|---|---|---|---|
| 24 | stalled_checkback | "Thanks for confirming the address. Please reach out if it still has not arrived by next Monday." | draft 1384 |
| 25 | lost_in_transit | "I'm so sorry to hear your order is lost in transit. I'll investigate and get back to you but likely I will need to send out another package." | draft 1924 |
| 26 | expedited_fail_refund | "So sorry about that. I sent over a refund for the expedited shipping." | draft 1665 (trimmed) |
| 27 | address_reship_confirm | "Ok, that explains it. The package was returned because of that small address difference. I've created a new order with the corrected address, [address]. You'll get a shipping confirmation with tracking once it's on its way." | draft 2129 |

## Defect

| # | situation | sample | source |
|---|---|---|---|
| 28 | defect_replace | "Thanks for letting me know, that shouldn't happen. Since the fit is right, I'll send a replacement Brooke in Black size 10. Could you send a quick photo of where the strap pulled away so I can pass it on to our supplier? You're welcome to keep the faulty one rather than send it back." | draft 1966 (sent identical) |

## Discount

| # | situation | sample | source |
|---|---|---|---|
| 29 | welcome_code_resend | "Sorry the welcome code didn't reach you. Here's the 10% off code: [CODE]" | draft 1589 |
| 30 | code_vs_sale_stacking | "Thanks for your order! You can save that discount code for the next purchase as the site would not have allowed it to be combined with the existing 15% off pride sale." | draft 2155 ✎ |

## Closing

| # | situation | sample | source |
|---|---|---|---|
| 31 | closing_heartfelt | "This made my day, thank you for sharing." | draft 2358, shortened per Jamie's review 2026-07-09 (the longer sent version was an accepted AI draft, not his own words) |
| 32 | closing_warm_short | "That's so kind, thank you. Hope she gets back in the water soon, 2.5 years is a long time to miss something she loves." | draft 2310 (sent identical) |

## Retire from the March set
All 51 March rows flip `active=false` unless a scenario above lacks coverage the old
row provided. Notable: the March `explaining_donation` samples predate the
donate-all-returns model — retire regardless (stale-policy risk).
