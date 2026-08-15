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
| **8** | Annual registration. Ro's reading: it carries no financial figures. | Not a reporting concern. |

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

## The forms, as they actually read

Ro supplied the forms on 2026-08-15. All three are made under **Regulation 11D(c)**, filed pursuant
to **section 4(7)(a)**. Every header asks for **Proprietors Strata Plan No., TRN No., and Name &
Address of Complex** — Villaggio Del Sol is **Strata Plan No. 2724**, now held in settings.

**13A — Income & Expenditure, for year ending ___.** Three columns: **Current Year | Outstanding
Amounts | Comments**. The "Outstanding" column is the interesting one — it ties to 13B for income and
to 13C for expenses, both of which the system already derives.

Its expense lines are fixed and do **not** match this application's expense categories:

> Security · Common Area Upkeep (Gardening, Minor Repairs, Insurance) · Property Tax ·
> Utilities (Electricity, Telephone, Water) · Special Projects (Painting, Major roof repairs, Other) ·
> Audit & Accounting (Bank Charges, Other)

Income lines: Maintenance Contributions · Levies/Cess · Interest on Deposits · Other Income.

The app has no Insurance or Bank Charges category, cannot split Utilities into Electricity /
Telephone / Water, and has Payroll, Supplies and Contractors with no obvious home on the form.
**This does not matter — see "How the return is actually filed" below.**

**13B — Outstanding Contributions.** `Strata Lot # | 30 days | 60 days | 90 days | 90 days & over`,
with a Total row. **Built.**

**13C — Outstanding Debts.** `Description | 30 days | 60 days | 90 days | Over 90 days`, with
Insurance / Property Tax / Light / Water / Other pre-printed and blank rows beneath. **Built.**

## Still to confirm with REBCSC

1. Whether Villaggio Del Sol's financial year ends 31 March (which sets the 120-day clock).
2. Whether this corporation needs *audited* statements or GAAP accounts signed by the executive.
   Note the requirement reads "audited **or, subject to the approval of the Commission**, accounts
   prepared under GAAP" — the cheaper route is a permission, not a right. Ask, and get it in writing.
3. Which currency the return is made in, and how a USD-billed levy should be presented. Nothing here
   converts between currencies without somebody choosing a rate.
4. The reserve fund obligation. **Parked at Ro's instruction, 2026-08-15.**

## How the return is actually filed — read this before "fixing" the categories

**Ro, 2026-08-15:** *"we generally send them an excel sheet of the breakdown, which is an acceptable
practice as their form cannot reflect their ask."*

So 13A's fixed lines are a template, not the deliverable. The Commission accepts an Excel breakdown
alongside it, because the printed form cannot express what a real property spends money on.

**This overturns what an earlier version of this note recommended.** Do *not* realign the
application's expense categories to match 13A's lines. That would bend the register to fit a form
nobody completes literally, lose detail the corporation actually manages by, and force costs like
payroll into a box the form never had. The categories should describe the property; the export
should carry the breakdown.

What matters instead is that **the export is good**: a clean spreadsheet of income and expenditure
for the year, broken down by category, with the amount outstanding beside each figure, and the
supporting detail behind it. That is the real reporting requirement, and it is what to build.

---

## Sources

- [Annual Return — REBCSC](https://reb.gov.jm/category/strata-corporation/annual-return/)
- [Strata Corporation (PSP) Annual Commitments — REBCSC](https://reb.gov.jm/strata-plan-psp-annual-commitments/)
- [Strata Corporations Urged to File Annual Returns — Jamaica Information Service](https://jis.gov.jm/strata-corporations-urged-to-file-annual-returns/)
- [The Registration (Strata Titles) Act — Laws of Jamaica](https://laws.moj.gov.jm/library/statute/the-registration-strata-titles-act)
- [The Registration (Strata Titles) (Amendment) Act, 2009 — Houses of Parliament](https://www.japarliament.gov.jm/attachments/341_The%20Registration%20(Strata%20Titles)%20(Amendment)%20Act,%202009.pdf)
