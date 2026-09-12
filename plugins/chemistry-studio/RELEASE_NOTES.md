# Chemistry Studio 2.2.0

Multi-step syntheses, drawn one balanced step at a time — and a change in what the package
does that is worth stating plainly.

## The coefficients are solved, not believed

Until now the model supplied the stoichiometric coefficients and Nodus checked them. Asking
a model to balance ten equations in a row is asking it to do arithmetic under a deadline,
which is where it fails; a route would die on a step whose chemistry was right and whose
numbers were not.

Nodus now solves them, by exact rational elimination over the element, isotope and charge
matrix. The model lists the species; the numbers are arithmetic and are treated as such.
Coefficients that came with the request are kept when they already balance, so an equation
someone wrote by hand comes back as they wrote it.

Two refusals stay refusals, because they are questions and not arithmetic. Species that
cannot balance at all name the element that is missing, so the next attempt is informed
rather than another guess. Species that admit more than one balanced equation — ethanol
burning to a mixture of CO and CO₂ — are refused rather than resolved: choosing one would
be inventing which reaction was meant.

## A route is a proposal, and says so

Each step is drawn as its own balanced scheme, with the conditions and the electron pushing
in a `notes` field shown beneath it, labelled as proposed and unchecked. That label is not
decoration. **What this package verifies has not changed:** that every species is a real
structure, and that every equation balances. Whether the route works, whether the conditions
are right, whether the yields are usable — none of that is checked by anything here, and the
answer says so.

This is the first release where Chemistry Studio renders something it cannot verify. It is
worth knowing which half is which.

With thanks to Avi, who wrote the original of this and tested it against thirty synthesis
problems before sending it.
