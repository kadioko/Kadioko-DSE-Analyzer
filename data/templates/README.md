# Fill-in templates for missing sessions

One file per DSE session that is absent from the platform, pre-filled with the
date and all 30 instruments so only the figures need entering.

## Why these exist

The 17–21 August 2026 sessions cannot be collected automatically:

- The exchange's daily reports for 19, 20 and 21 August are published only as
  converted PDFs carrying deliberate anti-extraction controls.
- 17 and 18 August are not linked on the exchange's homepage at all.
- Third-party aggregators that carry DSE instruments prohibit automated
  extraction in their terms.

A person reading a screen and entering figures is ordinary use, and is not
affected by any of the above. These templates make that quick.

## How to use one

1. Open the file for the session you have figures for.
2. Fill in the columns you know. **Leave anything you do not know blank** —
   blank means "no data", and the platform will show a dash. Never enter `0`
   for an unknown value; zero is a real number and will be treated as one.
3. Move the completed file into `data/incoming/`.
4. Run `npm run sync`, or double-click `UPDATE-DATA.bat`.

## Column notes

| Column | Notes |
| --- | --- |
| `Previous Close` | The prior session's close. On the exchange's own board this is the column labelled **Open** — its "Prev Close" column repeats Close and is unusable. |
| `Open` | The true opening price. Leave blank if unknown; it is not required. |
| `High` / `Low` | Leave blank when the counter did not trade. Do not enter `0`. |
| `Outstanding Bid` / `Offer` | `0` is meaningful here — it records an empty side of the book. |
| `Market Cap` | Absolute TZS, not billions. |

Every row goes through the same validation as any other import: a close outside
its own high/low is refused with a reason, and nothing is silently corrected.

## The supported alternative

The exchange sells exactly this data as **Historical daily Pricelists for equity
data**, in Excel and PDF, at **TZS 150,000/month** (USD 150). Contact
`data@dse.co.tz`. That is the route that scales.
