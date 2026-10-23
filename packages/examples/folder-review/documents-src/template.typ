// Shared layout for the synthetic contract PDFs. Fonts are the ones bundled
// with typst, ligatures and hyphenation are off so the text extracts cleanly,
// and every page says the document is invented.
#let contract(title: "", subtitle: "", body) = {
  set document(title: title, author: "Stablehand folder review demo")
  set page(
    paper: "a4",
    margin: (x: 2.2cm, top: 2.2cm, bottom: 2.6cm),
    footer: context [
      #set text(size: 8pt, fill: luma(110))
      Synthetic sample for the Stablehand folder review demo. Every party in it is invented.
      #h(1fr)
      Page #counter(page).display() of #counter(page).final().first()
    ],
  )
  set text(font: "Libertinus Serif", size: 10.5pt, lang: "en", ligatures: false, hyphenate: false)
  set par(justify: false, leading: 0.7em, spacing: 1.1em)
  show heading.where(level: 2): set text(size: 11.5pt)
  show heading.where(level: 2): set block(above: 1.4em, below: 0.7em)
  align(center)[
    #text(size: 15pt, weight: "bold")[#title]
    #if subtitle != "" [ \ #text(size: 10.5pt)[#subtitle] ]
  ]
  v(0.8em)
  body
}
