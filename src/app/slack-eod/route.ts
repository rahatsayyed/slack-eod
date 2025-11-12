import axios from "axios";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";

const GITLAB_API = process.env.GITLAB_API!;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN!;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID!;
const GITLAB_USER_ID = process.env.GITLAB_USER_ID!;
const GITLAB_EMAIL = process.env.GITLAB_EMAIL;
const GITLAB_USERNAME = process.env.GITLAB_USERNAME;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const SLACK_USER_ID = process.env.SLACK_USER_ID!;
const AI_MODEL_NAME = process.env.AI_MODEL_NAME!;
const AI_BASE_URL = process.env.AI_BASE_URL!;
const AI_API_KEY = process.env.AI_API_KEY!;

const openai = new OpenAI({ apiKey: AI_API_KEY, baseURL: AI_BASE_URL });
const slack = new WebClient(SLACK_BOT_TOKEN);

/**
 * Helpers: IST-aware date utilities
 */
function istNow(): Date {
  // get current time in IST as a Date object
  const now = new Date();
  const istString = now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  return new Date(istString);
}

function istMidnightFromDateString(dateInput: string): Date {
  // interpret YYYY-MM-DD as midnight IST
  return new Date(`${dateInput}T00:00:00+05:30`);
}

function toIsoUTC(d: Date) {
  return new Date(d.getTime()).toISOString();
}

function formatIstLabel(d: Date) {
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Core handler logic
 *
 * Behavior:
 * - If dateParam provided => treat as that IST day (since = YYYY-MM-DD 00:00 IST, until = +24h)
 * - Else => rolling last 24 hours in IST (since = now_ist - 24h, until = now_ist)
 */
async function handleEODRequest(dateParam?: string) {
  // determine since / until in IST
  let sinceIst: Date;
  let untilIst: Date;
  if (dateParam) {
    // calendar day in IST
    sinceIst = istMidnightFromDateString(dateParam);
    untilIst = new Date(sinceIst.getTime() + 24 * 60 * 60 * 1000);
  } else {
    // rolling last 24 hours (IST)
    untilIst = istNow();
    sinceIst = new Date(untilIst.getTime() - 24 * 60 * 60 * 1000);
  }

  const sinceIso = toIsoUTC(sinceIst); // for GitLab (UTC ISO)
  const untilIso = toIsoUTC(untilIst);

  const labelSince = formatIstLabel(sinceIst);
  const labelUntil = formatIstLabel(untilIst);

  console.log(`📅 Generating EOD for window: ${labelSince} → ${labelUntil} (IST)`);
  console.log(`🔁 Using GitLab window: since=${sinceIso} until=${untilIso} (UTC)`);

  // ---------------------------------------------------------------------------
  // 1. Gather relevant branches:
  //    - take branches with a latest commit in the recent window (we'll use 7 days relative to 'untilIst')
  //    - also include source_branch for MRs updated within our since→until window (and a small margin)
  // ---------------------------------------------------------------------------
  let allBranches: string[] = [];

  try {
    const branchesRes = await axios.get(
      `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/repository/branches?per_page=200`,
      { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } }
    );

    // active branches: use cutoff relative to 'untilIst'
    const cutoff = new Date(untilIst.getTime() - 7 * 24 * 60 * 60 * 1000);

    const activeBranches = branchesRes.data
      .filter((b: any) => b.commit && new Date(b.commit.created_at) > cutoff)
      .map((b: any) => b.name);

    allBranches.push(...activeBranches);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch branches:", err.message || err);
  }

  // include MR source branches updated within our window (use updated_after/updated_before)
  try {
    const mrRes = await axios.get(
      `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/merge_requests`,
      {
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
        params: {
          updated_after: sinceIso,
          updated_before: untilIso,
          per_page: 100,
        },
      }
    );
    const mrBranches = mrRes.data.map((mr: any) => mr.source_branch).filter(Boolean);
    allBranches.push(...mrBranches);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch MRs for branches:", err.message || err);
  }

  const branches = Array.from(new Set(allBranches.filter(Boolean)));
  console.log(`🌿 Branch candidates count: ${branches.length}`);

  // ---------------------------------------------------------------------------
  // 2. Collect commits authored by you across those branches in the since→until window
  // ---------------------------------------------------------------------------
  let commits: Array<{ id: string; title: string; web_url: string; branch: string }> = [];

  const authorFilter = GITLAB_EMAIL || GITLAB_USERNAME;
  for (const branch of branches) {
    try {
      const res = await axios.get(
        `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/repository/commits`,
        {
          headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
          params: {
            ref_name: branch,
            since: sinceIso,
            until: untilIso,
            author: authorFilter,
            per_page: 100,
          },
        }
      );

      if (res.data?.length) {
        commits.push(
          ...res.data.map((c: any) => ({ id: c.id, title: c.title, web_url: c.web_url, branch }))
        );
      }
    } catch (err: any) {
      // ignore 404 or permission errors for a branch; warn for others
      if (err.response?.status && err.response.status !== 404) {
        console.warn(`⚠️ commits fetch failed for branch ${branch}: ${err.message || err}`);
      }
    }
  }

  // dedupe by commit id
  const seen = new Set<string>();
  commits = commits.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  console.log(`✅ Found ${commits.length} commits authored by you in window.`);

  const commitLines = commits.map((c) => `• ${c.title} (${c.branch}) → ${c.web_url}`);

  // ---------------------------------------------------------------------------
  // 3. Fetch MRs authored by you in window
  // ---------------------------------------------------------------------------
  let createdMRs: string[] = [];
  try {
    const createdRes = await axios.get(
      `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/merge_requests`,
      {
        headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
        params: {
          author_id: GITLAB_USER_ID,
          updated_after: sinceIso,
          updated_before: untilIso,
          per_page: 100,
        },
      }
    );
    createdMRs = createdRes.data.map((mr: any) => `• ${mr.title} (${mr.web_url})`);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch created MRs:", err.message || err);
  }

  // ---------------------------------------------------------------------------
  // 4. Fetch MRs you reviewed in window (global endpoint supports reviewer filter)
  // ---------------------------------------------------------------------------
  let reviewedMRs: string[] = [];
  try {
    const reviewedRes = await axios.get(`${GITLAB_API}/merge_requests`, {
      headers: { "PRIVATE-TOKEN": GITLAB_TOKEN },
      params: {
        reviewer_id: GITLAB_USER_ID,
        updated_after: sinceIso,
        updated_before: untilIso,
        per_page: 100,
      },
    });
    reviewedMRs = reviewedRes.data.map((mr: any) => `• ${mr.title} (${mr.web_url})`);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch reviewed MRs:", err.message || err);
  }

  // ---------------------------------------------------------------------------
  // 5. Build activity text
  // ---------------------------------------------------------------------------
  const activity = `
Commits (${commitLines.length}):
${commitLines.length ? commitLines.join("\n") : "None"}

MRs Created:
${createdMRs.length ? createdMRs.join("\n") : "None"}

MRs Reviewed:
${reviewedMRs.length ? reviewedMRs.join("\n") : "None"}
`;

  console.log("---- raw activity ----");
  console.log(activity);

  // ---------------------------------------------------------------------------
  // 6. Summarize via OpenAI
  // ---------------------------------------------------------------------------
  const aiPrompt = `Summarize the following GitLab activity into a concise EOD update for a Slack message.
Time window (IST): ${labelSince} → ${labelUntil}
Raw activity:
${activity}
Keep it short (3-6 bullets), action-oriented, and professional, no vague eod updates.

Output format:
*EOD UPDATE* (date)
- main topic
  - subtopic (if any)
  - subtopic (if any)
- main topic
  - subtopic (if any)

if not any activity, say " *EOD UPDATE* 
No activity on gitlab".
`;

  let eodSummary = activity;
  try {
    const aiResponse = await openai.chat.completions.create({
      model: AI_MODEL_NAME,
      messages: [
        { role: "system", content: "You are a concise assistant generating daily developer EOD summaries." },
        { role: "user", content: aiPrompt },
      ],
    });
    eodSummary = aiResponse.choices?.[0]?.message?.content?.trim() || activity;
  } catch (err: any) {
    console.warn("⚠️ OpenAI summary failed, using raw activity:", err.message || err);
  }

  // ---------------------------------------------------------------------------
  // 7. Post to Slack (explicitly include the IST window in the Slack message so there's no ambiguity)
  // ---------------------------------------------------------------------------
  const slackDateLabel = `${labelSince} → ${labelUntil}`; // human friendly
  const slackMessage = `${eodSummary}`;

  await slack.chat.postMessage({
    channel: SLACK_USER_ID,
    text: slackMessage,
  });

  return { ok: true, message: `EOD sent for window ${slackDateLabel}` };
}

/**
 * GET handler (supports ?date=YYYY-MM-DD)
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date") ?? undefined;
    const result = await handleEODRequest(dateParam);
    return Response.json(result);
  } catch (error: any) {
    console.error("EOD GET error:", error.response?.data || error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}

/**
 * POST handler (supports { "date": "YYYY-MM-DD" })
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const dateParam = body.date ?? undefined;
    const result = await handleEODRequest(dateParam);
    return Response.json(result);
  } catch (error: any) {
    console.error("EOD POST error:", error.response?.data || error.message);
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }
}
