// The campaign kit (Ads tab, owner only, 2026-11-20): a ready-to-paste Google Search plan built from the practice's
// own clinics: one English campaign per clinic picked plus one Spanish campaign across them, each with its ad
// groups (search words), ads written to Google's length limits, the words to block, and the extras.
//
// Nothing here talks to Google. The owner copies it into Google Ads (or downloads it as a spreadsheet); the same
// campaign codes are created in MyPCP so every booking and call is counted against the right campaign.
import { adCode, trackingSuffix, AD_SITE } from "./ads";
import { CLINIC_PHONE, NOT_ACCEPTED, SELF_PAY } from "./insurance";

/** Google's limits for a responsive search ad and its extras. */
export const AD_LIMITS = { headline: 30, description: 90, path: 15, sitelink: 25, sitelinkLine: 35, callout: 25, snippet: 25, minHeadlines: 8, maxHeadlines: 15, maxDescriptions: 4 } as const;

export interface KitClinic { id: number; name: string; address?: string | null }
export interface KitOptions {
  /** Whole dollars a month for all campaigns together. */
  monthlyBudget: number;
  /** A campaign in Spanish across the picked clinics. */
  spanish: boolean;
  /** Search words from people with no insurance (the visit price goes in the ad). */
  selfPay: boolean;
  /** "Appointments this week" in the ads: only when that's true. */
  sameWeek: boolean;
  practiceName?: string;
}

export interface KitKeyword { text: string; match: "phrase" | "exact" }
export interface KitAdGroup {
  name: string;
  /** What kind of search this group answers. */
  about: string;
  keywords: KitKeyword[];
  headlines: string[];
  descriptions: string[];
  path1: string;
  path2: string;
  /** Something to check before it runs. */
  note?: string;
}
export interface KitArea { clinicId: number; clinicName: string; area: string; address: string | null; radiusMiles: number }
export interface KitCampaign {
  /** The campaign's name in Google Ads (it carries the code, so spend reports match by themselves). */
  googleName: string;
  /** The name it gets in MyPCP. */
  name: string;
  code: string;
  language: "en" | "es";
  clinicId: number | null;
  areas: KitArea[];
  dailyBudgetCents: number;
  monthlyBudgetCents: number;
  finalUrl: string;
  /** Campaign settings → "Final URL suffix". */
  suffix: string;
  adGroups: KitAdGroup[];
  negatives: string[];
}
export interface AdKit {
  campaigns: KitCampaign[];
  sitelinks: { text: string; line1: string; line2: string; url: string }[];
  callouts: string[];
  snippets: { header: string; values: string[] };
  settings: { label: string; value: string }[];
  /** Things only the practice can confirm before the ads go live. */
  confirm: string[];
  /** Lines the kit left out because they ran over Google's limits (should be none). */
  dropped: string[];
}

const strip = (s: string) => s.replace(/\s+/g, " ").trim();
/** "MyPCP Dr - Katy" → "Katy". */
export const kitShortName = (name: string) => strip(name.replace(/^my\s?pcp\s?(dr|doctor)?\.?\s*[-–:·]\s*/i, "")) || strip(name);

/** The place name people type for a clinic, and the neighborhoods next to it. Known Houston-area clinics first; else the clinic's own name. */
export function kitArea(c: KitClinic): { area: string; nearby: string[] } {
  const t = `${c.name} ${c.address ?? ""}`.toLowerCase();
  if (/richmond ave|westheimer|westchase|77082|77077/.test(t)) return { area: "West Houston", nearby: ["Westchase", "Alief"] };
  if (/cypress|lakeview haven|77095|77433|77429/.test(t)) return { area: "Cypress", nearby: ["Copperfield"] };
  if (/katy|provincial|highland knolls|cinco|77450|77494|77449/.test(t)) return { area: "Katy", nearby: ["Cinco Ranch"] };
  const city = /,\s*([A-Za-z .]+?),?\s+[A-Z]{2}\b/.exec(c.address ?? "")?.[1];
  return { area: strip(city ?? kitShortName(c.name)), nearby: [] };
}

const p = (text: string): KitKeyword => ({ text, match: "phrase" });
const e = (text: string): KitKeyword => ({ text, match: "exact" });

/** Searches that cost money and never become a patient here. Medicaid and the plans not taken come from the insurance list. */
export function kitNegatives(language: "en" | "es"): string[] {
  const common = [
    "medicaid", "chip", ...NOT_ACCEPTED.map((n) => n.name.toLowerCase()),
    "free", "jobs", "job", "hiring", "salary", "career", "careers", "school", "degree", "residency", "volunteer",
    "urgent care", "emergency room", "er", "hospital", "dentist", "dental", "eye doctor", "optometrist", "chiropractor", "dermatologist", "psychiatrist",
    "obgyn", "gynecologist", "veterinarian", "vet", "pediatrician",
    "lawsuit", "complaints", "reviews of",
    "cvs", "minute clinic", "walgreens", "walmart", "kelsey seybold", "memorial hermann", "houston methodist", "village medical", "legacy community health", "hca",
  ];
  const es = ["gratis", "trabajo", "empleo", "sueldo", "dentista", "pediatra", "emergencia", "hospital", "ginecologo", "veterinario", "oculista"];
  return Array.from(new Set(language === "es" ? [...common, ...es] : common));
}

function englishGroups(area: string, nearby: string[], o: KitOptions, brand: string): KitAdGroup[] {
  const a = area.toLowerCase();
  const fit = (...options: string[]) => options.find((x) => x.length <= AD_LIMITS.headline) ?? options[options.length - 1]!;
  const shared = [
    fit(`Primary Care in ${area}`, `Doctor in ${area}`, "Primary Care Near You"),
    "Accepting New Patients",
    "Book Your Visit Online",
    "Family Doctor Near You",
    fit(`${brand} - ${area}`, brand, "Your Local Primary Care"),
    "Most Insurance Accepted",
    "Se Habla Español",
    "Mon-Fri, 9 AM to 5 PM",
    `Call ${CLINIC_PHONE}`,
    ...(o.sameWeek ? ["Appointments This Week"] : []),
  ];
  const descriptions = [
    fit90(`New patients welcome at ${brand} in ${area}. Book online in 2 minutes or call us today.`, `New patients welcome at ${brand}. Book online in 2 minutes or call us today.`),
    "Checkups, physicals, diabetes and blood pressure care. Most major insurance accepted.",
    "Check your insurance on our website in seconds, then pick a day that works for you.",
    "A primary care team that knows you by name. Hablamos español.",
  ];
  const groups: KitAdGroup[] = [
    {
      name: "Doctor near me", about: "People looking for a primary care doctor close by. The biggest group.",
      keywords: [
        p("primary care doctor near me"), p("primary care physician near me"), p("family doctor near me"), p("pcp near me"), p("doctors office near me"),
        p(`primary care ${a}`), p(`family doctor ${a}`), p(`doctor ${a}`), e(`primary care doctor ${a}`), e(`pcp ${a}`),
        ...nearby.flatMap((n) => [p(`primary care ${n.toLowerCase()}`), p(`family doctor ${n.toLowerCase()}`)]),
      ],
      headlines: [...shared, "Annual Physicals & Checkups", "Diabetes & Blood Pressure Care", "A Doctor Who Knows Your Name"], descriptions, path1: "primary-care", path2: adPath(area),
    },
    {
      name: "New patients", about: "People saying outright that they need a new doctor.",
      keywords: [
        p("doctors accepting new patients near me"), p("primary care accepting new patients"), p("new patient appointment near me"), p("find a primary care doctor"),
        p("new primary care doctor"), e("doctors accepting new patients"), p(`doctors accepting new patients ${a}`), p("i need a primary care doctor"),
      ],
      headlines: ["New Patients Welcome", "Need a New Doctor?", "First Visit, No Long Wait", ...shared.filter((h) => h !== "Accepting New Patients")],
      descriptions, path1: "new-patients", path2: adPath(area),
      note: o.sameWeek ? undefined : "\"First Visit, No Long Wait\": keep it only if new patients are usually seen within about two weeks.",
    },
    {
      name: "Insurance", about: "People searching by their plan. These book fast when the ad says yes.",
      keywords: [
        p("doctors that take ambetter"), p("ambetter primary care doctor"), p("ambetter doctors near me"), p("oscar health doctors near me"), p("doctors that accept oscar"),
        p("blue cross blue shield doctors near me"), p("bcbs primary care near me"), p("molina marketplace doctors near me"), p("doctors that accept medicare near me"),
        p(`medicare doctors ${a}`), p("aetna primary care near me"), p("unitedhealthcare primary care near me"), p("cigna primary care near me"), p("tricare primary care near me"),
      ],
      headlines: ["We Take Your Insurance", "Ambetter, Oscar & BCBS", "Medicare Patients Welcome", "Aetna, Cigna & UHC Accepted", "Check Your Plan in Seconds", ...shared.filter((h) => h !== "Most Insurance Accepted")],
      descriptions: [
        "We accept Ambetter, Oscar, Blue Cross, Aetna, Cigna, UnitedHealthcare and Medicare.",
        "Not sure we take your plan? Check it on our website in seconds, then book your visit.",
        ...descriptions.slice(0, 2),
      ],
      path1: "insurance", path2: adPath(area),
      note: "Google sometimes holds ads that name insurance companies or Medicare for review. If one is held, the other headlines still run; nothing to fix unless Google asks.",
    },
    {
      name: "Physicals and checkups", about: "Yearly physicals and wellness visits: an easy first visit.",
      keywords: [
        p("annual physical near me"), p("physical exam near me"), p("yearly checkup near me"), p("wellness exam near me"), p("medicare annual wellness visit near me"),
        p(`annual physical ${a}`), p(`physical exam ${a}`), e("annual physical exam"), p("where to get a physical"),
      ],
      headlines: ["Annual Physical Exams", "Time for Your Yearly Checkup?", "Medicare Wellness Visits", "Wellness Exams for Adults", ...shared],
      descriptions: [
        fit90(`Yearly physicals and wellness exams in ${area}. Most plans cover one a year at no cost.`, "Yearly physicals and wellness exams. Most plans cover one a year at no cost."),
        "Book your annual physical online in 2 minutes. New patients welcome.",
        ...descriptions.slice(1, 3),
      ],
      path1: "physicals", path2: adPath(area),
      note: "\"Most plans cover one a year at no cost\" is true of most plans, not all. Take the line out if you'd rather not say it.",
    },
    {
      name: "Diabetes and blood pressure", about: "People looking for ongoing care: the patients who stay for years.",
      keywords: [
        p("diabetes doctor near me"), p("high blood pressure doctor near me"), p("doctor for diabetes"), p("cholesterol doctor near me"), p(`diabetes doctor ${a}`),
        p("primary care for diabetes"), p("hypertension doctor near me"),
      ],
      headlines: ["Diabetes & Blood Pressure Care", "Ongoing Care, One Team", "Help Managing Diabetes", "Blood Pressure Checkups", ...shared],
      descriptions: [
        "Ongoing care for diabetes, blood pressure and cholesterol from a team that follows up.",
        fit90(`Regular visits and check-ins between visits at ${brand} in ${area}. New patients welcome.`, "Regular visits and check-ins between visits. New patients welcome."),
        ...descriptions.slice(2, 4),
      ],
      path1: "ongoing-care", path2: adPath(area),
    },
  ];
  if (o.selfPay) {
    groups.push({
      name: "No insurance", about: "People paying out of pocket. Lower value per visit, paid the same day.",
      keywords: [p("doctor without insurance near me"), p("self pay doctor near me"), p("doctor visit no insurance"), p("affordable doctor visit near me"), p("cash price doctor visit"), p(`doctor no insurance ${a}`)],
      headlines: ["No Insurance? No Problem", `New Patient Visit $${SELF_PAY.firstVisit}`, `Follow-Up Visits $${SELF_PAY.followUp}`, "Clear Prices, No Surprises", ...shared.filter((h) => h !== "Most Insurance Accepted")],
      descriptions: [
        `No insurance? A new patient visit is $${SELF_PAY.firstVisit} and follow-up visits are $${SELF_PAY.followUp}. Book online today.`,
        "Clear prices before you come in. See a primary care provider this week or next.",
        ...descriptions.slice(2, 4),
      ],
      path1: "self-pay", path2: adPath(area),
      note: `Prices come from MyPCP's self-pay amounts ($${SELF_PAY.firstVisit} first visit, $${SELF_PAY.followUp} follow-up). Tests and shots are extra: say so on the page the ad opens.`,
    });
  }
  return groups;
}

function spanishGroups(areas: string[], o: KitOptions, brand: string): KitAdGroup[] {
  const place = areas.length === 1 ? areas[0]! : "Houston";
  const fit = (...options: string[]) => options.find((x) => x.length <= AD_LIMITS.headline) ?? options[options.length - 1]!;
  const shared = [
    fit(`Médico Primario en ${place}`, `Médico en ${place}`, "Médico Primario Cerca"),
    "Aceptamos Pacientes Nuevos",
    "Haga Su Cita en Línea",
    "Se Habla Español",
    "Doctores Que Hablan Español",
    "Aceptamos Muchos Seguros",
    "Clínica Médica Cerca de Usted",
    "Lunes a Viernes, 9 a 5",
    `Llame al ${CLINIC_PHONE}`,
    fit(brand, "Su Clínica de Confianza"),
    ...(o.sameWeek ? ["Citas Esta Semana"] : []),
  ];
  const descriptions = [
    `Pacientes nuevos bienvenidos en ${brand}. Haga su cita en línea o llámenos hoy.`,
    "Chequeos, exámenes físicos, diabetes y presión alta. Aceptamos muchos seguros médicos.",
    "Atención médica en español con un equipo que lo conoce por su nombre.",
    "Revise su seguro en nuestro sitio web en segundos y elija el día que le convenga.",
  ];
  const local = areas.map((x) => x.toLowerCase());
  const groups: KitAdGroup[] = [
    {
      name: "Médico cerca de mí", about: "Búsquedas en español de un médico primario o una clínica cercana.",
      keywords: [
        p("medico de cabecera cerca de mi"), p("doctor primario cerca de mi"), p("medico familiar cerca de mi"), p("clinica medica cerca de mi"), p("doctor cerca de mi"),
        p("clinica familiar cerca de mi"), p("medico general cerca de mi"), ...local.flatMap((a) => [p(`medico ${a}`), p(`clinica ${a}`), p(`doctor en ${a}`)]),
      ],
      headlines: [...shared, "Exámenes Físicos Anuales", "Cuidado de Diabetes y Presión"], descriptions, path1: "medico", path2: "espanol",
    },
    {
      name: "Doctor que habla español", about: "Personas que buscan un doctor que hable español. Poca competencia.",
      keywords: [
        p("doctor que hable español cerca de mi"), p("medico que hable español"), p("doctores hispanos cerca de mi"), p("clinica hispana cerca de mi"), p("doctor hispano"),
        p("spanish speaking doctor near me"), p("spanish speaking primary care"), ...local.map((a) => p(`clinica hispana ${a}`)),
      ],
      headlines: ["Su Doctor Habla Español", "Atención Médica en Español", "Clínica Hispana Cerca de Usted", ...shared.filter((h) => h !== "Doctores Que Hablan Español")],
      descriptions: [descriptions[2]!, descriptions[0]!, descriptions[1]!, descriptions[3]!], path1: "doctor", path2: "espanol",
    },
    {
      name: "Seguro y examen físico", about: "Búsquedas por seguro médico o por el examen físico anual.",
      keywords: [
        p("doctor que acepta ambetter"), p("doctores que aceptan medicare"), p("medico que acepta mi seguro"), p("doctores que aceptan oscar"), p("examen fisico anual"),
        p("chequeo medico general"), p("chequeo medico cerca de mi"), p("examen fisico cerca de mi"),
      ],
      headlines: ["Aceptamos Su Seguro Médico", "Ambetter, Oscar y Medicare", "Examen Físico Anual", "Revise Su Seguro en Segundos", ...shared.filter((h) => h !== "Aceptamos Muchos Seguros")],
      descriptions: [
        "Aceptamos Ambetter, Oscar, Blue Cross, Aetna, Cigna, UnitedHealthcare y Medicare.",
        "Examen físico anual y chequeos generales. Haga su cita en línea en 2 minutos.",
        descriptions[3]!, descriptions[2]!,
      ],
      path1: "seguro", path2: "espanol",
      note: "Google a veces revisa los anuncios que nombran seguros o Medicare. Si detiene uno, los demás siguen.",
    },
  ];
  if (o.selfPay) {
    groups.push({
      name: "Sin seguro", about: "Personas que pagan de su bolsillo.",
      keywords: [p("doctor sin seguro cerca de mi"), p("consulta medica sin seguro"), p("clinica economica cerca de mi"), p("cuanto cuesta una consulta medica"), p("doctor barato cerca de mi")],
      headlines: ["¿Sin Seguro? No Hay Problema", `Primera Consulta $${SELF_PAY.firstVisit}`, `Consultas de Seguimiento $${SELF_PAY.followUp}`, "Precios Claros", ...shared.filter((h) => h !== "Aceptamos Muchos Seguros")],
      descriptions: [
        `¿Sin seguro? La primera consulta cuesta $${SELF_PAY.firstVisit} y las de seguimiento $${SELF_PAY.followUp}. Haga su cita hoy.`,
        "Precios claros antes de su visita. Atención médica en español.", descriptions[0]!, descriptions[2]!,
      ],
      path1: "sin-seguro", path2: "espanol",
      note: `Precios de MyPCP: $${SELF_PAY.firstVisit} primera consulta, $${SELF_PAY.followUp} seguimiento. Los exámenes y vacunas son aparte.`,
    });
  }
  return groups;
}

function fit90(...options: string[]): string {
  return options.find((x) => x.length <= AD_LIMITS.description) ?? options[options.length - 1]!;
}
/** The short word shown after the web address in the ad ("mypcpdr.com/primary-care/katy"). */
function adPath(area: string): string {
  return adCode(area).slice(0, AD_LIMITS.path).replace(/-+$/g, "") || "clinic";
}

/** Split a daily amount so it adds back up to the cent. */
function splitBudget(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  const out = weights.map((w) => Math.floor((totalCents * w) / sum));
  let left = totalCents - out.reduce((s, x) => s + x, 0);
  for (let i = 0; left > 0; i = (i + 1) % out.length, left--) out[i]!++;
  return out;
}

/**
 * Build the kit: one English campaign per clinic (its own budget, so money can be moved to the clinic with open
 * slots) and, when asked, one Spanish campaign across all of them. Spanish gets a quarter of the budget.
 */
export function buildAdKit(clinics: KitClinic[], o: KitOptions): AdKit {
  const brand = strip(o.practiceName || "MyPCP Dr");
  const dropped: string[] = [];
  const monthlyCents = Math.max(0, Math.round(o.monthlyBudget * 100));
  const areas: KitArea[] = clinics.map((c) => ({ clinicId: c.id, clinicName: c.name, area: kitArea(c).area, address: c.address?.trim() || null, radiusMiles: 6 }));
  // Two clinics in the same town (Katy has two) get told apart by their own names in the campaign.
  const label = (c: KitClinic) => (clinics.filter((x) => kitArea(x).area === kitArea(c).area).length > 1 ? kitShortName(c.name) : kitArea(c).area);
  const weights = [...clinics.map(() => (o.spanish ? 0.75 : 1) / Math.max(1, clinics.length)), ...(o.spanish ? [0.25] : [])];
  const monthly = splitBudget(monthlyCents, weights);
  const clean = (campaign: string, g: KitAdGroup): KitAdGroup => {
    const keep = (list: string[], max: number, cap: number, what: string) => {
      const ok: string[] = [];
      for (const x of Array.from(new Set(list.map(strip)))) {
        if (x.length > max) dropped.push(`${campaign} / ${g.name}: ${what} too long (${x.length}): ${x}`);
        else if (ok.length < cap) ok.push(x);
      }
      return ok;
    };
    return { ...g, headlines: keep(g.headlines, AD_LIMITS.headline, AD_LIMITS.maxHeadlines, "headline"), descriptions: keep(g.descriptions, AD_LIMITS.description, AD_LIMITS.maxDescriptions, "description") };
  };
  const campaigns: KitCampaign[] = clinics.map((c, i) => {
    const { area, nearby } = kitArea(c);
    const name = `Google Search - ${label(c)}`;
    const code = adCode(`g-${label(c)}-en`);
    const base = { channel: "google_search", code };
    return {
      googleName: `Search | ${label(c)} | English | ${code}`, name, code, language: "en" as const, clinicId: c.id, areas: [areas[i]!],
      monthlyBudgetCents: monthly[i]!, dailyBudgetCents: Math.round(monthly[i]! / 30.4), finalUrl: AD_SITE, suffix: trackingSuffix(base),
      adGroups: englishGroups(area, nearby, o, brand).map((g) => clean(name, g)), negatives: kitNegatives("en"),
    };
  });
  if (o.spanish && clinics.length) {
    const code = "g-espanol";
    const cents = monthly[monthly.length - 1]!;
    const name = "Google Search - Español";
    campaigns.push({
      googleName: `Search | Español | ${code}`, name, code, language: "es", clinicId: clinics.length === 1 ? clinics[0]!.id : null, areas,
      monthlyBudgetCents: cents, dailyBudgetCents: Math.round(cents / 30.4), finalUrl: AD_SITE, suffix: trackingSuffix({ channel: "google_search", code }),
      adGroups: spanishGroups(Array.from(new Set(areas.map((a) => a.area))), o, brand).map((g) => clean(name, g)), negatives: kitNegatives("es"),
    });
  }
  const within = <T,>(list: T[], text: (x: T) => string[], max: number[], what: string) => list.filter((x) => {
    const bad = text(x).find((s, i) => s.length > max[i]!);
    if (bad) dropped.push(`${what} too long (${bad.length}): ${bad}`);
    return !bad;
  });
  const sitelinks = within([
    { text: "Book an Appointment", line1: "Pick a clinic and a day online.", line2: "We call you to confirm the time.", url: `${AD_SITE}appointments` },
    { text: "Check Your Insurance", line1: "See if we take your plan.", line2: "It takes a few seconds.", url: AD_SITE },
    { text: "Our Clinics", line1: `${clinics.length || "Several"} clinics in the Houston area.`, line2: "Find the one closest to you.", url: AD_SITE },
    { text: "Citas en Español", line1: "Haga su cita en español.", line2: "Le llamamos para confirmar.", url: AD_SITE },
  ], (s) => [s.text, s.line1, s.line2], [AD_LIMITS.sitelink, AD_LIMITS.sitelinkLine, AD_LIMITS.sitelinkLine], "sitelink");
  const callouts = within(["New Patients Welcome", "Se Habla Español", "Online Booking", "Most Insurance Accepted", "Mon-Fri 9 to 5", "Medicare Accepted"], (s) => [s], [AD_LIMITS.callout], "callout");
  const snippetValues = within(["Annual Physicals", "Wellness Exams", "Diabetes Care", "Blood Pressure Care", "Chronic Care", "Medicare Wellness Visits"], (s) => [s], [AD_LIMITS.snippet], "snippet");
  return {
    campaigns, sitelinks, callouts, snippets: { header: "Services", values: snippetValues },
    settings: [
      { label: "Campaign type", value: "Search. Turn OFF \"Display Network\" and \"Search partners\" (they spend the budget on poor clicks)." },
      { label: "Where the ads show", value: "A 6-mile circle around each clinic's address. Under Location options pick \"Presence: people in or regularly in your locations\"." },
      { label: "Languages", value: "English campaigns: English. The Spanish campaign: Spanish AND English (many people search in Spanish on a phone set to English)." },
      { label: "Bidding", value: "Start with \"Maximize clicks\" and a top price per click of $6. After about 30 bookings are counted, switch to \"Maximize conversions\"." },
      { label: "Search words", value: "Phrase and exact match only, as listed. No broad match for the first two months." },
      { label: "Tracking", value: "Paste each campaign's \"Final URL suffix\" in Campaign settings → Campaign URL options. That is what lets MyPCP count each booking." },
      { label: "Phone", value: "Add a call extension. Show it Mon-Fri 9 AM to 5 PM only, so nobody calls an empty office." },
      { label: "First two weeks", value: "Open \"Search terms\" twice a week and add anything off-target to the blocked words. This is where most wasted money is caught." },
    ],
    confirm: [
      "Every clinic picked is taking new patients and has open visits in the next two weeks.",
      "Website booking requests get a call back within 15 minutes during office hours. This matters more than anything in the ads.",
      "The insurance plans named in the ads are still accepted at each clinic picked.",
      ...(o.sameWeek ? ["\"Appointments this week\" is true at each clinic picked."] : []),
      ...(o.selfPay ? [`The self-pay prices in the ads ($${SELF_PAY.firstVisit} / $${SELF_PAY.followUp}) are current.`] : []),
      "Someone at each clinic can speak Spanish with patients who call from the Spanish ads.",
    ],
    dropped,
  };
}

/** The whole kit as spreadsheet rows (one line per search word, ad, blocked word and extra). */
export function kitRows(kit: AdKit): (string | number)[][] {
  const head = ["Campaign", "Ad Group", "Row", "Keyword", "Match Type", ...Array.from({ length: AD_LIMITS.maxHeadlines }, (_, i) => `Headline ${i + 1}`), ...Array.from({ length: AD_LIMITS.maxDescriptions }, (_, i) => `Description ${i + 1}`), "Path 1", "Path 2", "Final URL", "Final URL suffix", "Daily budget"];
  const pad = (list: string[], n: number) => Array.from({ length: n }, (_, i) => list[i] ?? "");
  const blanks = (n: number) => Array.from({ length: n }, () => "");
  const rows: (string | number)[][] = [head];
  for (const c of kit.campaigns) {
    rows.push([c.googleName, "", "Campaign", "", "", ...blanks(AD_LIMITS.maxHeadlines + AD_LIMITS.maxDescriptions + 2), c.finalUrl, c.suffix, (c.dailyBudgetCents / 100).toFixed(2)]);
    for (const g of c.adGroups) {
      rows.push([c.googleName, g.name, "Ad", "", "", ...pad(g.headlines, AD_LIMITS.maxHeadlines), ...pad(g.descriptions, AD_LIMITS.maxDescriptions), g.path1, g.path2, c.finalUrl, "", ""]);
      for (const k of g.keywords) rows.push([c.googleName, g.name, "Keyword", k.text, k.match === "exact" ? "Exact" : "Phrase", ...blanks(AD_LIMITS.maxHeadlines + AD_LIMITS.maxDescriptions + 5)]);
    }
    for (const n of c.negatives) rows.push([c.googleName, "", "Blocked word", n, "Negative Phrase", ...blanks(AD_LIMITS.maxHeadlines + AD_LIMITS.maxDescriptions + 5)]);
  }
  return rows;
}
