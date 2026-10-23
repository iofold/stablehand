#import "template.typ": contract
#show: contract.with(
  title: "Supply Agreement",
  subtitle: "Fernway and Ampelfield Components, signed 12 February 2026",
)

Ampelfield Components ("Supplier") makes e-bike frames and batteries. Fernway buys them for the bikes it rents out. Both companies are fictional.

== 1. Products

Supplier sells Fernway City 2 frames and 504 Wh batteries to the specifications in Schedule 2.

== 2. Forecasts and orders

2.1 Fernway sends a rolling six-month forecast on the first working day of each month.

2.2 Purchase orders become binding when Supplier confirms them in writing.

2.3 Fernway orders at least 400 battery units in each calendar quarter. If it orders fewer, it pays a shortfall fee of 8% of the price of the missing units.

#pagebreak()

== 3. Exclusivity

During the term Fernway buys all of its e-bike batteries from Supplier.

== 4. Delivery

4.1 Supplier delivers to Fernway's warehouse within 21 days of confirming an order.

4.2 Risk passes to Fernway on delivery.

== 5. Warranty

5.1 Batteries are warranted for 18 months from delivery and frames for 5 years.

5.2 Supplier replaces a faulty battery within 10 working days of a claim.

#pagebreak()

== 6. Prices

6.1 Prices are listed in Schedule 1 and exclude VAT.

6.2 Prices include delivery to Fernway's warehouse.

6.3 Supplier may raise prices once per calendar year by up to 12%, with 60 days' written notice.

== 7. Term

This Agreement starts on 1 March 2026 and runs for 3 years.

== 8. Termination

Either party may terminate this Agreement if the other commits a material breach and does not remedy it within 45 days of written notice.

== Schedule 1: Prices

#table(
  columns: (1fr, auto),
  stroke: 0.5pt + luma(170),
  inset: 6pt,
  [Battery, 504 Wh], [212 EUR per unit],
  [Frame, City 2], [148 EUR per unit],
)
