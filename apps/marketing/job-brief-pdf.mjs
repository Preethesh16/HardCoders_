// Small dependency-free PDF writer for the demo intake round-trip. The visible
// document is useful to people; the base64 comment preserves the exact labeled
// source text so the API can deterministically parse an Anchor-generated PDF
// even when the optional AI adapter is unavailable.

function clean(value) {
  return String(value ?? "").replace(/\r\n?/gu, "\n").trim();
}

function list(value) {
  return Array.isArray(value) ? value.map(clean).filter(Boolean) : clean(value).split(/\n|;/u).map(item => item.replace(/^[-*]\s*/u, "").trim()).filter(Boolean);
}

function oneLine(value) {
  return clean(value).replace(/\n+/gu, " ");
}

function labeledText(input) {
  const milestones = Array.isArray(input.milestones) ? input.milestones.slice(0, 5) : [];
  const milestoneBased = input.deliveryMode === "MILESTONES" && milestones.length > 1;
  const rows = [
    milestoneBased ? "ANCHOR MILESTONE JOB BRIEF" : "ANCHOR SINGLE-DELIVERY JOB BRIEF",
    "Demonstration document — review all extracted fields before publishing.",
    "",
    `Title: ${oneLine(input.title)}`,
    `Scope of work: ${oneLine(input.description)}`,
    `Acceptance criteria: ${list(input.acceptanceCriteria).join("; ")}`,
    `Required skills: ${list(input.skills).join("; ")}`,
    `Budget: ${clean(input.budget)}`,
    `Payer country: ${clean(input.payerCountry)}`,
    `Funding currency: ${clean(input.fundingCurrency)}`,
    `Target delivery date: ${clean(input.deliveryDate)}`,
    `Delivery model: ${milestoneBased ? "Milestone releases" : "One complete delivery"}`,
    `Milestone count: ${milestoneBased ? milestones.length : 0}`,
  ];
  if (!milestoneBased) rows.push("Release condition: Full escrow releases once after the complete delivery is approved.");
  milestones.filter(() => milestoneBased).forEach((milestone, index) => {
    const ordinal = index + 1;
    rows.push(
      "",
      `Milestone ${ordinal} title: ${oneLine(milestone.title)}`,
      `Milestone ${ordinal} description: ${oneLine(milestone.description)}`,
      `Milestone ${ordinal} deliverable: ${oneLine(milestone.deliverable)}`,
      `Milestone ${ordinal} acceptance criteria: ${list(milestone.acceptanceCriteria).join("; ")}`,
      `Milestone ${ordinal} amount: ${clean(milestone.amount)}`,
      `Milestone ${ordinal} due date: ${clean(milestone.dueDate)}`,
    );
  });
  return rows.join("\n");
}

function pdfEscape(value) {
  return value.replace(/[\\()]/gu, character => `\\${character}`).replace(/[^\x20-\x7e]/gu, "-");
}

function wrappedLines(text, width = 88) {
  const lines = [];
  for (const sourceLine of text.split("\n")) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    let remaining = sourceLine;
    while (remaining.length > width) {
      let split = remaining.lastIndexOf(" ", width);
      if (split < 24) split = width;
      lines.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

export function createJobBriefPdf(input) {
  const source = labeledText(input);
  const marker = Buffer.from(source, "utf8").toString("base64");
  const chunks = [];
  const allLines = wrappedLines(source);
  while (allLines.length) chunks.push(allLines.splice(0, 48));
  if (chunks.length === 0) chunks.push(["ANCHOR JOB BRIEF"]);

  const pageIds = chunks.map((_, index) => 4 + index * 2);
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>");
  chunks.forEach((lines, index) => {
    const pageId = pageIds[index];
    const contentId = pageId + 1;
    const operators = ["BT", "/F1 10 Tf", "13 TL", "54 760 Td"];
    lines.forEach((line, lineIndex) => {
      if (lineIndex > 0) operators.push("T*");
      operators.push(`(${pdfEscape(line)}) Tj`);
    });
    operators.push("ET");
    const stream = `${operators.join("\n")}\n`;
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  });

  let output = `%PDF-1.4\n%ANCHOR_JOB_BRIEF_BASE64:${marker}\n`;
  const offsets = [0];
  const maximumId = Math.max(...objects.keys());
  for (let id = 1; id <= maximumId; id += 1) {
    offsets[id] = Buffer.byteLength(output);
    output += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output);
  output += `xref\n0 ${maximumId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maximumId; id += 1) output += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${maximumId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}
