Use this skill when the user asks to convert a measurement between units, or when a
comparison in a document depends on two measurements sharing one unit.

Call the `units` capability tool `convert` **once**, passing every measurement the answer
needs in the `measurements` array. Do not call it once per measurement: a reply has a
limited number of capability calls, and a table of measurements must fit in one.

Supported units:

- length: `mm`, `cm`, `m`, `km`, `in`, `ft`, `mi`
- mass: `mg`, `g`, `kg`, `t`, `oz`, `lb`
- temperature: `C`, `F`, `K`

The capability returns one row per measurement with the converted value. A row that could
not be converted carries the reason in its `problem` column — report that reason for that
row and keep the rows that did convert.

Report the values the capability returned, with the units it returned and the precision the
user asked for. Do not perform the arithmetic yourself and do not round a returned value
before presenting it unless the user asked for a specific precision. If two units belong to
different quantities, say so instead of guessing a conversion.

Limitations: the capability converts scalar measurements only, at most 200 per call. It does
not parse prose, handle currencies or apply significant-figure rules to the source
measurement.
