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
 * Helpers: Proper date utilities for last 24 hours
 */
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
 * - If dateParam provided => treat as that IST calendar day (midnight to midnight IST)
 * - Else => rolling last 24 hours (now - 24h to now, in actual UTC)
 */
async function handleEODRequest(dateParam?: string) {
  let sinceUtc: Date;
  let untilUtc: Date;

  if (dateParam) {
    // Calendar day in IST: parse YYYY-MM-DD as IST midnight
    const istMidnight = new Date(`${dateParam}T00:00:00+05:30`);
    sinceUtc = istMidnight;
    untilUtc = new Date(istMidnight.getTime() + 24 * 60 * 60 * 1000);
  } else {
    // Rolling last 24 hours: just use current UTC time
    untilUtc = new Date(); // Current time in UTC
    sinceUtc = new Date(untilUtc.getTime() - 24 * 60 * 60 * 1000); // 24 hours ago
  }

  const sinceIso = sinceUtc.toISOString();
  const untilIso = untilUtc.toISOString();

  // Format for display (IST timezone for human readability)
  const labelSince = formatIstLabel(sinceUtc);
  const labelUntil = formatIstLabel(untilUtc);

  console.log(
    `📅 Generating EOD for window: ${labelSince} → ${labelUntil} (displayed in IST)`
  );
  console.log(
    `🔁 Using GitLab window: since=${sinceIso} until=${untilIso} (UTC)`
  );

  // ---------------------------------------------------------------------------
  // 1. Gather relevant branches
  // ---------------------------------------------------------------------------
  let allBranches: string[] = [];

  try {
    const branchesRes = await axios.get(
      `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/repository/branches?per_page=200`,
      { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } }
    );

    // Active branches: use cutoff relative to 'untilUtc'
    const cutoff = new Date(untilUtc.getTime() - 7 * 24 * 60 * 60 * 1000);

    const activeBranches = branchesRes.data
      .filter((b: any) => b.commit && new Date(b.commit.created_at) > cutoff)
      .map((b: any) => b.name);

    allBranches.push(...activeBranches);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch branches:", err.message || err);
  }

  // Include MR source branches updated within our window
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
    const mrBranches = mrRes.data
      .map((mr: any) => mr.source_branch)
      .filter(Boolean);
    allBranches.push(...mrBranches);
  } catch (err: any) {
    console.warn("⚠️ Could not fetch MRs for branches:", err.message || err);
  }

  const branches = Array.from(new Set(allBranches.filter(Boolean)));
  console.log(`🌿 Branch candidates count: ${branches.length}`);

  // ---------------------------------------------------------------------------
  // 2. Collect commits authored by you in the time window
  // ---------------------------------------------------------------------------
  let commits: Array<{
    id: string;
    title: string;
    web_url: string;
    branch: string;
  }> = [];

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
          ...res.data.map((c: any) => ({
            id: c.id,
            title: c.title,
            web_url: c.web_url,
            branch,
          }))
        );
      }
    } catch (err: any) {
      if (err.response?.status && err.response.status !== 404) {
        console.warn(
          `⚠️ commits fetch failed for branch ${branch}: ${err.message || err}`
        );
      }
    }
  }

  // Dedupe by commit id
  const seen = new Set<string>();
  commits = commits.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });

  console.log(`✅ Found ${commits.length} commits authored by you in window.`);

  const commitLines = commits.map(
    (c) => `• ${c.title} (${c.branch}) → ${c.web_url}`
  );

  // ---------------------------------------------------------------------------
  // 3. Fetch MRs authored by you in window (WITH DESCRIPTIONS)
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
    createdMRs = createdRes.data.map((mr: any) => {
      const description = mr.description?.trim() || "No description provided";
      return `• ${mr.title}\n  Description: ${description}\n  URL: ${mr.web_url}`;
    });
  } catch (err: any) {
    console.warn("⚠️ Could not fetch created MRs:", err.message || err);
  }

  // ---------------------------------------------------------------------------
  // 4. Fetch MRs you reviewed in window
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
    reviewedMRs = reviewedRes.data.map(
      (mr: any) => `• ${mr.title} (${mr.web_url})`
    );
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

  // ---------------------------------------------------------------------------
  // 6. Summarize via OpenAI
  // ---------------------------------------------------------------------------
  const aiPrompt = `Summarize the following GitLab activity into a concise EOD update for a Slack message.
Time window: ${labelSince} → ${labelUntil}
Raw activity:
${activity}

Instructions:
1. Keep it short (3-6 bullets), action-oriented, and professional
2. No vague updates - be specific about what was done
3. Group related work together under main topics
4. Use nested bullet points (with proper indentation using spaces) for subtopics

IMPORTANT - Follow this exact format:

*EOD UPDATE* (${labelSince.split(",")[0]})
• Main accomplishment or feature area
  ◦ Specific detail or subtask
  ◦ Another specific detail
• Another main accomplishment
  ◦ Specific detail

If there's no activity, respond with exactly:
*EOD UPDATE*
No activity on GitLab today.

Use bullet point characters:
- Main points: • (bullet)
- Sub-points: ◦ (white bullet) with 2 spaces indentation
`;

  let eodSummary = activity;
  try {
    const aiResponse = await openai.chat.completions.create({
      model: AI_MODEL_NAME,
      messages: [
        {
          role: "system",
          content:
            "You are a concise assistant generating daily developer EOD summaries.",
        },
        { role: "user", content: aiPrompt },
      ],
    });
    eodSummary = aiResponse.choices?.[0]?.message?.content?.trim() || activity;
  } catch (err: any) {
    console.warn(
      "⚠️ OpenAI summary failed, using raw activity:",
      err.message || err
    );
  }
  console.log("generated eod summary");

  // ---------------------------------------------------------------------------
  // 7. Post to Slack
  // ---------------------------------------------------------------------------
  const slackDateLabel = `${labelSince} → ${labelUntil}`;
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
