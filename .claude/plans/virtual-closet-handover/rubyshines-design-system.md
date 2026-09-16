# rubyshines.com design system

For the high-fidelity stage of the Virtual Closet. Extracted from the live theme (Shopify Online Store 2.0, Dawn-derived, repo rubies-ecom-v4) on 2026-09-16. Values are exact; do not round them.

## Brand

RUBIES makes gender-affirming underwear and swimwear for trans girls and women. Signature no-tuck shaping technology (never "patented"). Tagline on the site: "Never stop shining." Mission line: "Every girl deserves to shine."

Personality: playful but respectful, confident but approachable, positive and supportive, quality but not high-end. Never political, righteous or judgmental.

## Logo

- File: `rubies-logo.svg` (this folder). Horizontal wordmark, viewBox 489 × 135. Three fills: magenta `#FB00FF`, orange `#FFAA42`, lime `#B3FE00`.
- Live: https://rubyshines.com/cdn/shop/files/RUBIES-horizontal-logo-pink-green-rgb.svg (header, 170 px wide on desktop, 90 px on mobile). Square mark for favicons: RUBIES-logo-pink-green-rgb.svg.
- Always on white or the light grey ground. Never recolour it.

## Colour

Theme colour schemes (the site is built from these five; scheme-1 is the default page ground):

| Scheme | Background | Text | Button | Button label | Used for |
|---|---|---|---|---|---|
| scheme-1 | `#FFFFFF` | `#310C48` | `#121212` | `#FFFFFF` | Page ground, most sections |
| scheme-2 | `#F3F3F3` | `#310C48` | `#121212` | `#F3F3F3` | Product, collection and blog cards |
| scheme-3 | `#242833` | `#FFFFFF` | `#FFFFFF` | `#000000` | Dark sections, sold-out badge |
| scheme-4 | `#1E052E` | `#FFFFFF` | `#FFFFFF` | `#121212` | Deep purple sections |
| scheme-5 | `#2000A0` | `#FFFFFF` | `#FFFFFF` | `#2000A0` | Blue sections, sale badge |

Brand accents in use:

- Magenta `#FB00FF`: the logo's first colour and the site's brand accent (review stars, review buttons, links in reviews). Use sparingly for the one lifted element on a page and for primary emphasis.
- Purple `#310C48`: all body and UI text on light grounds.
- Blue `#2000A0`: secondary accent (scheme-5 blocks, sale badges, some link colours).
- Orange `#FFAA42` and lime `#B3FE00`: logo colours; the site uses them only in the logo and illustrations. A single lime or orange tag can carry a "raised so far" style callout if it is the only one on the page.
- Neutrals: white `#FFFFFF`, light grey `#F3F3F3`, near-black `#121212`.
- Text and border opacity conventions: input borders at 55% of the text colour; media borders at 5%; card borders at 10%.

Rule: on the Virtual Closet pages, text stays `#310C48` on white, buttons stay near-black, and magenta is the single accent. Do not introduce a cream or off-white ground; the site is white and light grey.

## Typography

- Body and headings: **Fixel Display** (self-hosted, OpenType). Weights available: 300 (ExtraLight file), 400 (Light file), 500 (Regular file), 600 (SemiBold), 700 (Bold). The theme's Google-font setting is Assistant, but the stylesheet overrides it to Fixel Display everywhere including buttons. Fallback: a geometric sans (Assistant, then system sans).
- Display accent: **Motter Corpus Std** Regular, used only for italicised words inside headings (`h1 i`, `h2 i`, `h3 i`): 50 px in h1, 40 px in h2, 32 px in h3, weight 400, line-height 1.2. This is how the site puts one playful word in a heading.
- Font files (Shopify CDN): FixelDisplay-{ExtraLight,Light,Regular,SemiBold,Bold}.{otf,woff2} and Motter_Corpus_Std_Regular.otf under https://cdn.shopify.com/s/files/1/0255/9636/2837/files/.
- Base body: 14 px on the stylesheet's body rule, with the layout setting body copy at 1.5 rem on mobile and 1.6 rem from 750 px up, letter-spacing 0.06 rem, line-height calc(1 + 0.8 / 1) = 1.8, weight 400. Bold body weight 700.
- Heading weight is 400 (light, airy headings), heading scale 1.0. Custom size settings in use: h3 mobile 22 px, large paragraph mobile 18 px, small paragraph mobile 13 px, main menu 20 px at weight 500.
- Product names on cards are set in uppercase (for example "AJ NO-TUCK SHAPING UNDERWEAR").

## Shape and spacing

- **Buttons are square**: radius 0, 1 px border at full opacity, no shadow. Minimum 12 rem wide and 4.5 rem tall, padding 0 3 rem, font-size 1.5 rem, inline-flex centred. Primary: near-black `#121212` fill with white text. Secondary: white fill with `#121212` text and border. Hover: opacity 0.8 with a 0.4 s transition. Active: translateY(4 px) and opacity 0.8.
- **Inputs**: radius 0, 1 px border at 55% opacity, no shadow.
- **Variant pills and badges**: radius 40 px (pill-shaped), 1 px border at 55% opacity. This is the only rounded element family on the site; use it for size chips, tags and the "raised so far" callout.
- **Cards, media, text boxes, popups**: radius 0, no shadow. Cards sit on `#F3F3F3`.
- **Page width**: 1200 px content width (the stylesheet's global override sets the page container to 144 rem). Section spacing setting is 0; sections butt against each other and use their own padding.
- **Grid gaps**: 8 px horizontal and vertical on desktop, 4 px on mobile (product grids are tight).
- Mobile-first: the theme is authored mobile-first with breakpoints at 750 px and 990 px.

## Imagery

- Product photography on white, square crops, models in the product; the same photo per product drives the card, so cards read as a clean grid.
- Colour swatches on product cards, round, one per colourway; the site's colourways include Black, Pink, Sandstone, White, Unicorn, Mint, Sunshine, Turquoise, Neon Green, Orange, Royal Blue, Fuchsia, Floral.
- Flat vector character illustrations are used for category and "how it works" art (adult and kids, underwear, swim, active). No stock photography, no gradients as backgrounds.
- Reviews (Judge.me) appear in magenta stars.

## Components the Virtual Closet should reuse

- Header and footer of the store are not part of the closet page; the closet page carries only the logo (linked to the store) in its own header and footer.
- Product card: square image, uppercase name, price, swatches, on the light grey card ground, square corners.
- Button pair: one square primary, one square secondary, side by side; on the closet page there are three doors, so allow a third secondary.
- Size chips: pill-shaped, 1 px border.
- Progress bar: not an existing site component; draw it as a flat bar in magenta on `#F3F3F3`, square ends to match the site, height 12 to 16 px.
- Announcement style tag: pill with a single brand colour fill for "$88 raised so far".

## Copy rules that touch design

- No em dashes. Plus sizes read 1X, 2X, 3X, 4X. They/them by default. Never "patented".
- Headings may carry one italic word in Motter Corpus Std for warmth, in the site's manner, but not on every heading.
- Uppercase only on product names and nav, never on body copy or eyebrow labels.
