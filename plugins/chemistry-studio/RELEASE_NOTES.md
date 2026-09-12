# Chemistry Studio 2.1.0

Two depictions that were previously refused, and the refusals were right at the time: there
was no way to produce either without the model telling Nodus where the hydrogens and the
electron pairs went, which is exactly what this package does not let it do. Both are derived
now, so both are supported.

## Wedge-and-dash

Ask for wedge-and-dash, tetrahedral perspective or explicit hydrogens and every hydrogen is
expanded from the verified graph, with stereocentres labelled R/S and stereogenic double
bonds E/Z. A molecule with one tetrahedral centre and no stereocentre — chloroform,
dichloromethane — carries no wedge in its graph at all, so nothing would have been drawn;
Nodus now chooses one solid wedge and one hashed bond, perpendicular in the projection, so
the shape reads as tetrahedral instead of flat.

## Lewis structures

Ask for lone pairs, nonbonding pairs or a Lewis structure and each pair is counted from
valence electrons, formal charge and the bonds already drawn — never supplied by the model.
Stereochemistry is not required for one: a Lewis structure is about where the electrons are,
not which isomer it is.

Neither depiction has a ChemFig export, and neither asserts anything about reactivity.

## Also

Carbon dioxide was refused as a cumulated-diene stereochemistry case. Two double bonds on
one carbon are axial chirality only when a double-bonded neighbour carries the chain onwards,
as in an allene; a terminal system has no stereochemistry to get wrong.

With thanks to Avi, who wrote the original of all of this.
