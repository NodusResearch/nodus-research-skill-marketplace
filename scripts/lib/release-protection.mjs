import { REQUIRED_CHECKS } from './release-automation.mjs';

// The maintainer's explicit merge authorizes publication, including their own PRs.
// This exception concerns reviews only; status checks apply even to administrators.
export function mainProtection(codeownersReady) {
  return {
    required_status_checks: { strict: true, checks: REQUIRED_CHECKS.map(context => ({ context, app_id: 15368 })) },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true, require_code_owner_reviews: true,
      required_approving_review_count: codeownersReady ? 0 : 1,
      require_last_push_approval: false,
      bypass_pull_request_allowances: { users: ['jorgepb96'], teams: [], apps: [] },
    },
    restrictions: null, required_linear_history: false,
    allow_force_pushes: false, allow_deletions: false,
    required_conversation_resolution: true,
  };
}

export function assertMainProtection(policy, codeownersReady) {
  const required = mainProtection(codeownersReady);
  if (!policy.required_status_checks?.strict || !policy.enforce_admins?.enabled) {
    throw new Error('Main CI checks must apply to administrators and an up-to-date branch.');
  }
  for (const expected of required.required_status_checks.checks) {
    if (!policy.required_status_checks.checks?.some(c => c.context === expected.context && c.app_id === expected.app_id)) {
      throw new Error(`Missing required GitHub Actions check: ${expected.context}`);
    }
  }
  const reviews = policy.required_pull_request_reviews;
  if (!reviews?.require_code_owner_reviews || !reviews.dismiss_stale_reviews
    || reviews.required_approving_review_count !== required.required_pull_request_reviews.required_approving_review_count) {
    throw new Error('Main review protection does not match the source/catalog policy.');
  }
  const bypass = reviews.bypass_pull_request_allowances;
  if (bypass?.apps?.length || bypass?.teams?.length || bypass?.users?.length !== 1 || bypass.users[0].login !== 'jorgepb96') {
    throw new Error('No bot, app, team or other account may bypass source review.');
  }
  if (policy.allow_force_pushes?.enabled || policy.allow_deletions?.enabled) throw new Error('Force pushes and deletion must remain disabled.');
}

export function assertMainSigningPolicy(policies) {
  if (policies.length !== 1 || policies[0].name !== 'main' || policies[0].type !== 'branch') {
    throw new Error('The signing environment must accept only the main branch and no tags.');
  }
}
