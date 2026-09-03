const pillars = [
  ['Verified parties', 'Signed identity claims for companies and freelancers, without publishing private documents.'],
  ['Explainable rules', 'Versioned regulatory sources, deterministic decisions, and a complete as-of audit record.'],
  ['Controlled settlement', 'Human approval and Fabric-enforced state before an idempotent wallet release.'],
] as const;

export default function Home() {
  return (
    <main>
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="OptiWork home">
          <span className="brandMark">O</span>
          OptiWork
        </a>
        <span className="prototype">Decision-support prototype</span>
      </nav>

      <section id="top" className="hero">
        <p className="eyebrow">Cross-border work, with the financial logic visible</p>
        <h1>Hire globally.<br />Settle with confidence.</h1>
        <p className="lede">
          A verified freelance workflow that connects contracts, regulatory evidence,
          FX, escrow, work approval, and a tamper-evident audit trail.
        </p>
        <div className="actions">
          <a className="primary" href="#architecture">Explore the architecture</a>
          <span>US company <b>→</b> Indian freelancer</span>
        </div>
      </section>

      <section id="architecture" className="pillars" aria-label="Architecture principles">
        {pillars.map(([title, description], index) => (
          <article key={title}>
            <span className="number">0{index + 1}</span>
            <h2>{title}</h2>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <footer>
        Prototype only — not a licensed remittance service or legal/tax advice.
      </footer>
    </main>
  );
}
