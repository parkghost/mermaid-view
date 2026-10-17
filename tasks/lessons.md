# Lessons

## Verify drawing features in every look
A change to how the drawing is clicked or lit was checked only in the classic look; in the
hand-drawn look Mermaid classes nodes `rough-node`, not `node`, so nothing lit.
- Rule: verify anything that reads the rendered SVG in all three looks (classic, Neo, hand-drawn),
  and across the diagram types, not just one flowchart.
- How: render each type's syntax-reference example in each look and compare what links
  (the probe used: count `link.hit` matches per type and look; they must agree).
