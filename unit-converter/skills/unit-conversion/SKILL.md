Use this skill when the user asks to convert a measurement between units, or when a
comparison in a document depends on two measurements sharing one unit.

Call the `units` capability tool `convert` once per measurement, with the numeric value and
the exact source and target unit symbols. Supported units are:

- length: `mm`, `cm`, `m`, `km`, `in`, `ft`, `mi`
- mass: `mg`, `g`, `kg`, `t`, `oz`, `lb`
- temperature: `C`, `F`, `K`

Report the value the capability returned, with the unit it returned and the precision the
user asked for. Do not perform the arithmetic yourself and do not round the returned value
before presenting it unless the user asked for a specific precision. If the two units belong
to different quantities, say so instead of guessing a conversion.

Limitations: the capability converts one scalar measurement at a time. It does not parse
prose, handle currencies or apply significant-figure rules to the source measurement.
