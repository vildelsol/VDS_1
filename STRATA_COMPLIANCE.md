# Strata compliance — what Jamaica actually requires, and what this system can produce

Researched 2026-08-15 from the regulator's own pages. **This is a working note for building the
software, not legal advice.** Confirm the details with the corporation's auditor or attorney, and
with the Commission directly, before filing anything. Where I could not verify something I have said
so rather than guessed.

The regulator is the **Real Estate Board / Commission of Strata Corporations (REBCSC)**.

---

## The annual filing

**Deadline: within 120 days of the end of the financial year** (cited as section 4(7) of the
Registration (Strata Titles) (Amendment) Act). Annual registration falls due on or before 1 April,
with fees billed on a yearly statement of account; the filing fee is quoted at $1,000.

**Forms: 8, 13A, 13B and 13C.**

| Form | What it is | Does the system hold this? |
|---|---|---|
| **13A** | Income and expenditure statement | **Mostly.** Charges give income raised, payments give cash, expenses give expenditure. Framing is cash-movement; an auditor will want levies *raised* as income. |
| **13B** | Outstanding contributions — what proprietors owe | **Yes, essentially complete.** `delinquentAccounts` / `accountBalance` already produce this per villa per currency, with ageing. Missing only the **strata lot number**. |
| **13C** | Outstanding payables — what the corporation owes third parties | **Yes.** Expenses with `status: 'pending'` are exactly this, and the monthly-costs run raises them that way by design. |
| **8** | Not verified — confirm with REBCSC what Form 8 covers. | Unknown. |

**Supporting documents required with the return:**

- Minutes of the AGM (and any EGM) held in the financial year, with supporting documents
- Notice of the meeting
- **A list of all proprietors with their balances and strata lot numbers, as at the date of the
  meeting** ← the system can produce the balances today but does **not** record strata lot numbers
- Audited financial statements, or accounts prepared under GAAP, **signed by the Chairman and at
  least one other executive committee member**
- Names and addresses of the current executive committee
- Proof of insurance
- Resolutions passed — including the resolution adopting the budget, and (if applicable) the
  unanimous resolution required to waive insurance

On acceptance the Commission issues a **Certificate of Compliance**.

A corporation in sole ownership of every lot may apply for a waiver using **Form 14**.

---

## The two things the model was missing

**Unit entitlement.** Contributions must be levied on proprietors **in proportion to their unit
entitlement** — the proportionate share attaching to each strata lot. The system stored
`monthlyMaintenance` as a free-typed figure per villa with nothing behind it, so it could not show
that Villa 3's levy bears the correct relationship to Villa 11's. That is the question an owner asks
at an AGM. Being built now.

**Reserve / contingency fund.** The corporation is required to determine annually what proprietors
contribute to the operating fund *and* to a reserve for major repairs and replacements. The system
has one undifferentiated pot and no fund accounting. Not built yet.

I could **not** extract the governing section numbers for the reserve fund: both the principal Act
and the 2009 amendment are published as scanned images, so the text is not machine-readable. The
requirement is corroborated across secondary sources but **the exact obligation and any minimum
should be confirmed before building to it.**

---

## Still to confirm with REBCSC

1. What Form 8 covers.
2. The exact line items on 13A, 13B and 13C — build the reports to the real forms, not to a
   reasonable guess at them.
3. Whether Villaggio Del Sol's financial year ends 31 March (which sets the 120-day clock).
4. Whether this corporation needs *audited* statements or GAAP accounts signed by the executive.
5. The reserve fund obligation in precise terms.

---

## Sources

- [Annual Return — REBCSC](https://reb.gov.jm/category/strata-corporation/annual-return/)
- [Strata Corporation (PSP) Annual Commitments — REBCSC](https://reb.gov.jm/strata-plan-psp-annual-commitments/)
- [Strata Corporations Urged to File Annual Returns — Jamaica Information Service](https://jis.gov.jm/strata-corporations-urged-to-file-annual-returns/)
- [The Registration (Strata Titles) Act — Laws of Jamaica](https://laws.moj.gov.jm/library/statute/the-registration-strata-titles-act)
- [The Registration (Strata Titles) (Amendment) Act, 2009 — Houses of Parliament](https://www.japarliament.gov.jm/attachments/341_The%20Registration%20(Strata%20Titles)%20(Amendment)%20Act,%202009.pdf)
