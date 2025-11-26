import axios from "axios";

const GITLAB_API = process.env.GITLAB_API!;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN!;
const GITLAB_PROJECT_ID = process.env.GITLAB_PROJECT_ID!;
const GITLAB_USER_ID = process.env.GITLAB_USER_ID!;
const GITLAB_EMAIL = process.env.GITLAB_EMAIL;
const GITLAB_USERNAME = process.env.GITLAB_USERNAME;

/**
 * Debug route to inspect GitLab commits and MRs
 * GET /api/debug-gitlab?date=YYYY-MM-DD (optional)
 * 
 * Returns detailed information about:
 * - All branches and their last commit dates
 * - Commits from each branch in the time window
 * - MRs created and reviewed
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

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const dateParam = url.searchParams.get("date");

    // Determine time window
    let sinceUtc: Date;
    let untilUtc: Date;

    if (dateParam) {
      const istMidnight = new Date(`${dateParam}T00:00:00+05:30`);
      sinceUtc = istMidnight;
      untilUtc = new Date(istMidnight.getTime() + 24 * 60 * 60 * 1000);
    } else {
      untilUtc = new Date();
      sinceUtc = new Date(untilUtc.getTime() - 24 * 60 * 60 * 1000);
    }

    const sinceIso = sinceUtc.toISOString();
    const untilIso = untilUtc.toISOString();

    const debugInfo: any = {
      timeWindow: {
        since: sinceIso,
        until: untilIso,
        sinceIST: formatIstLabel(sinceUtc),
        untilIST: formatIstLabel(untilUtc),
      },
      config: {
        gitlabAPI: GITLAB_API,
        projectId: GITLAB_PROJECT_ID,
        userId: GITLAB_USER_ID,
        email: GITLAB_EMAIL || "not set",
        username: GITLAB_USERNAME || "not set",
        authorFilter: GITLAB_EMAIL || GITLAB_USERNAME,
      },
      branches: [],
      commitsPerBranch: {},
      mrsSummary: {},
      errors: [],
    };

    // ---------------------------------------------------------------------------
    // 1. FETCH ALL BRANCHES with their last commit info
    // ---------------------------------------------------------------------------
    console.log("📦 Fetching all branches...");
    try {
      const branchesRes = await axios.get(
        `${GITLAB_API}/projects/${GITLAB_PROJECT_ID}/repository/branches?per_page=200`,
        { headers: { "PRIVATE-TOKEN": GITLAB_TOKEN } }
      );

      const cutoff = new Date(untilUtc.getTime() - 7 * 24 * 60 * 60 * 1000);

      debugInfo.branches = branchesRes.data.map((b: any) => {
        const commitDate = b.commit ? new Date(b.commit.created_at) : null;
        const isActive = commitDate && commitDate > cutoff;
        
        return {
          name: b.name,
          lastCommitDate: commitDate ? commitDate.toISOString() : "unknown",
          lastCommitDateIST: commitDate ? formatIstLabel(commitDate) : "unknown",
          isActive,
          lastCommitMessage: b.commit?.message || "N/A",
          lastCommitAuthor: b.commit?.author_name || "N/A",
        };
      });

      debugInfo.branchStats = {
        total: branchesRes.data.length,
        active: debugInfo.branches.filter((b: any) => b.isActive).length,
      };

      console.log(`✅ Found ${debugInfo.branches.length} total branches, ${debugInfo.branchStats.active} active`);
    } catch (err: any) {
      const error = `Branch fetch failed: ${err.response?.status} - ${err.message}`;
      debugInfo.errors.push(error);
      console.error("❌", error);
    }

    // ---------------------------------------------------------------------------
    // 2. FETCH MRs and collect source branches
    // ---------------------------------------------------------------------------
    console.log("🔀 Fetching MRs...");
    let mrBranches: string[] = [];
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

      debugInfo.mrsSummary.updatedInWindow = mrRes.data.map((mr: any) => ({
        title: mr.title,
        sourceBranch: mr.source_branch,
        author: mr.author?.name,
        updatedAt: mr.updated_at,
        state: mr.state,
        webUrl: mr.web_url,
      }));

      mrBranches = mrRes.data.map((mr: any) => mr.source_branch).filter(Boolean);
      console.log(`✅ Found ${mrRes.data.length} MRs updated in window`);
    } catch (err: any) {
      const error = `MR fetch failed: ${err.response?.status} - ${err.message}`;
      debugInfo.errors.push(error);
      console.error("❌", error);
    }

    // ---------------------------------------------------------------------------
    // 3. COMBINE BRANCHES (active + MR branches)
    // ---------------------------------------------------------------------------
    const activeBranches = debugInfo.branches
      .filter((b: any) => b.isActive)
      .map((b: any) => b.name);
    
    const allBranches = Array.from(
      new Set([...activeBranches, ...mrBranches])
    ).filter(Boolean);

    debugInfo.branchSelection = {
      activeBranches: activeBranches.length,
      mrBranches: mrBranches.length,
      combinedUnique: allBranches.length,
      branches: allBranches,
    };

    // ---------------------------------------------------------------------------
    // 4. FETCH COMMITS FOR EACH BRANCH
    // ---------------------------------------------------------------------------
    console.log(`🔍 Fetching commits from ${allBranches.length} branches...`);
    const authorFilter = GITLAB_EMAIL || GITLAB_USERNAME;

    for (const branch of allBranches) {
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

        debugInfo.commitsPerBranch[branch] = {
          count: res.data.length,
          commits: res.data.map((c: any) => ({
            id: c.id,
            short_id: c.short_id,
            title: c.title,
            author_name: c.author_name,
            author_email: c.author_email,
            created_at: c.created_at,
            created_at_IST: formatIstLabel(new Date(c.created_at)),
            web_url: c.web_url,
          })),
        };

        if (res.data.length > 0) {
          console.log(`  ✅ ${branch}: ${res.data.length} commits`);
        }
      } catch (err: any) {
        const status = err.response?.status;
        const message = err.response?.data?.message || err.message;
        
        debugInfo.commitsPerBranch[branch] = {
          error: `${status} - ${message}`,
          count: 0,
          commits: [],
        };

        if (status !== 404) {
          console.warn(`  ⚠️ ${branch}: ${status} - ${message}`);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // 5. FETCH MRs CREATED BY USER
    // ---------------------------------------------------------------------------
    console.log("📝 Fetching MRs created by you...");
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

      debugInfo.mrsSummary.createdByUser = createdRes.data.map((mr: any) => ({
        title: mr.title,
        description: mr.description?.substring(0, 200) || "No description",
        sourceBranch: mr.source_branch,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        state: mr.state,
        webUrl: mr.web_url,
      }));

      console.log(`✅ Found ${createdRes.data.length} MRs created by you`);
    } catch (err: any) {
      const error = `Created MRs fetch failed: ${err.response?.status} - ${err.message}`;
      debugInfo.errors.push(error);
      console.error("❌", error);
    }

    // ---------------------------------------------------------------------------
    // 6. FETCH MRs REVIEWED BY USER
    // ---------------------------------------------------------------------------
    console.log("👀 Fetching MRs reviewed by you...");
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

      debugInfo.mrsSummary.reviewedByUser = reviewedRes.data.map((mr: any) => ({
        title: mr.title,
        author: mr.author?.name,
        state: mr.state,
        webUrl: mr.web_url,
      }));

      console.log(`✅ Found ${reviewedRes.data.length} MRs reviewed by you`);
    } catch (err: any) {
      const error = `Reviewed MRs fetch failed: ${err.response?.status} - ${err.message}`;
      debugInfo.errors.push(error);
      console.error("❌", error);
    }

    // ---------------------------------------------------------------------------
    // 7. SUMMARY STATISTICS
    // ---------------------------------------------------------------------------
    const totalCommits = Object.values(debugInfo.commitsPerBranch).reduce(
      (sum: number, branch: any) => sum + (branch.count || 0),
      0
    );

    const branchesWithCommits = Object.entries(debugInfo.commitsPerBranch)
      .filter(([_, data]: any) => data.count > 0)
      .map(([name, data]: any) => ({ name, count: data.count }));

    debugInfo.summary = {
      totalBranches: allBranches.length,
      branchesWithCommitsLen: branchesWithCommits.length,
      totalCommitsByYou: totalCommits,
      mrsCreatedByYou: debugInfo.mrsSummary.createdByUser?.length || 0,
      mrsReviewedByYou: debugInfo.mrsSummary.reviewedByUser?.length || 0,
      branchesWithCommits,
    };

    console.log("\n📊 SUMMARY:");
    console.log(`  Branches checked: ${allBranches.length}`);
    console.log(`  Branches with your commits: ${branchesWithCommits.length}`);
    console.log(`  Total commits by you: ${totalCommits}`);
    console.log(`  MRs created by you: ${debugInfo.summary.mrsCreatedByYou}`);
    console.log(`  MRs reviewed by you: ${debugInfo.summary.mrsReviewedByYou}`);

    return Response.json(debugInfo, { status: 200 });
  } catch (error: any) {
    console.error("❌ Debug route error:", error);
    return Response.json(
      {
        ok: false,
        error: error.message,
        stack: error.stack,
      },
      { status: 500 }
    );
  }
}