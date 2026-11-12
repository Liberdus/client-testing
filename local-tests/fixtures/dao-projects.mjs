import assert from 'node:assert/strict';
import { DAO_PROJECT_MAX_MILESTONES, DAO_PROPOSAL_DAY_MS } from '../dao.js';

const HOUR_MS = 60 * 60 * 1000;

// Synthetic server responses only. The optional upstream callback is supplied by a test.
export class DaoProjectFixtures {
  constructor({ now, address = 'a'.repeat(40), queryUpstream = null }) {
    assert.ok(Number.isSafeInteger(now) && now > 0);
    const normalizedAddress = address.replace(/^0x/i, '');
    assert.match(normalizedAddress, /^[a-f0-9]{40}(?:0{24})?$/i);
    this.now = now;
    this.address = normalizedAddress.slice(0, 40).toLowerCase();
    this.queryUpstream = queryUpstream;
    this.proposals = new Map(this.createScenarios().map((scenario, index) => {
      const number = 901 + index;
      return [number, this.createProposal(number, scenario)];
    }));
  }

  milestone(number, overrides = {}) {
    return {
      title: `Milestone ${number}: deliver the release`,
      description: `Implement and document milestone ${number}.`,
      deliverable: `A public milestone ${number} release with acceptance evidence.`,
      duration: (15 + number) * DAO_PROPOSAL_DAY_MS,
      costUsdStr: String(number * 1000), penaltyUsdStr: String(number * 100),
      bonusUsdStr: String(number * 50), status: 'pending', paid: '0',
      startTime: null, endTime: null, proposedTime: null,
      endorsedTime: [], terminateVotes: [],
      ...overrides,
    };
  }

  project(overrides = {}) {
    return {
      address: 'a'.repeat(40), balance: '0', rateUsdStr: '0.5',
      durationBonusPercentage: 20, durationPenaltyPercentage: 20,
      startTime: null, endTime: null, endorsedAddress: [],
      milestones: [this.milestone(1)],
      ...overrides,
    };
  }

  createScenarios() {
    const completed = this.milestone(1, {
      status: 'completed', startTime: this.now - 20 * HOUR_MS,
      endTime: this.now - 2 * HOUR_MS, paid: '1000000000000000000',
    });
    const longDescription = 'A detailed public release with reviewable acceptance evidence. '.repeat(7).trim();
    return [
      { status: 'review', label: 'Review', project: this.project() },
      { status: 'voting', label: 'Voting with long copy', project: this.project({
        milestones: [this.milestone(1, { description: longDescription }), this.milestone(2), this.milestone(3)],
      }) },
      { status: 'accepted', label: 'Accepted pending activation', project: this.project({
        milestones: Array.from({ length: DAO_PROJECT_MAX_MILESTONES }, (_, index) => this.milestone(index + 1)),
      }) },
      { status: 'withheld', label: 'Withheld', project: this.project() },
      { status: 'rejected', label: 'Rejected', project: this.project() },
      { status: 'executing', label: 'Executing project', project: this.project({
        balance: '125000000000000000000', startTime: this.now - 20 * HOUR_MS,
        milestones: [completed, this.milestone(2, {
          status: 'executing', startTime: this.now - HOUR_MS / 2,
        }), this.milestone(3)],
      }) },
      { status: 'completed', label: 'Completed project', project: this.project({
        startTime: this.now - 20 * HOUR_MS, endTime: this.now - HOUR_MS,
        milestones: [completed],
      }) },
      { status: 'terminated', label: 'Terminated project', project: this.project({
        balance: '250000000000000000', startTime: this.now - 20 * HOUR_MS,
        endTime: this.now - HOUR_MS, milestones: [this.milestone(1, { status: 'terminated' })],
      }) },
      { status: 'canceled', label: 'Canceled', project: this.project() },
      { status: 'accepted', label: 'Accepted with claimable reward', claimable: true, project: this.project() },
      { status: 'applied', label: 'Missing project data' },
      { status: 'voting', label: 'Partial malformed project', project: {
        address: 'invalid', balance: 'invalid', milestones: [null, {
          title: '', description: 'Only this description is available.', deliverable: '',
          duration: 'unknown', costUsdStr: 'invalid', bonusUsdStr: '0', penaltyUsdStr: '0',
          status: 'unknown', paid: 'sometimes',
        }],
      } },
    ];
  }

  timeline(status) {
    const durations = {
      creationTime: this.now - 4 * HOUR_MS, reviewDuration: HOUR_MS, votingDuration: HOUR_MS,
    };
    if (status === 'review') return { ...durations, startTime: this.now - HOUR_MS / 2 };
    if (status === 'voting') {
      return { ...durations, startTime: this.now - 1.5 * HOUR_MS, votingStartedAt: this.now - HOUR_MS / 2 };
    }
    const votingEndedAt = this.now - (['executing', 'completed', 'terminated'].includes(status) ? 22 : 1) * HOUR_MS;
    return {
      ...durations, creationTime: votingEndedAt - 3 * HOUR_MS,
      startTime: votingEndedAt - 2 * HOUR_MS,
      votingStartedAt: votingEndedAt - HOUR_MS, votingEndedAt,
    };
  }

  createProposal(number, { status, label, claimable = false, project }) {
    return {
      id: `synthetic-project-${number}`, number, status, proposalType: 'project',
      title: `[Fixture ${number}] [Project status: ${status}] ${label}`,
      description: 'Synthetic project data for offline regression tests.',
      emergency: false,
      options: ['no', 'Fund project'],
      totalVote: status === 'rejected' ? ['12000000000000', '2000000000000'] : ['2000000000000', '12000000000000'],
      winningOptionIndex: status === 'rejected' ? 0 : 1,
      committeeAddresses: ['2'.repeat(40), '3'.repeat(40), '4'.repeat(40)], committeeVotes: [],
      voteThresholdUsdStr: '0.4', minimumSpendUsdStr: '0.1', voteExponent: 1,
      ...this.timeline(status), claimDuration: 2 * HOUR_MS, gracePeriod: 0,
      voterRewardPool: '100000000000000000000', claimedReward: '10000000000000000000',
      initialBurnedReward: '0', finalBurnedReward: '0',
      voterList: claimable ? [{ address: this.address, timestamp: this.now - 1.5 * HOUR_MS }] : [],
      claimList: [], ...(project ? { project } : {}),
    };
  }

  queryDaoApi = async (path) => {
    if (path === '/dao/proposals/meta') {
      const entries = [...this.proposals.values()].map(({ number, status }) => ({
        proposal: number, status, emergencyFlag: false, timestamp: this.now - number,
      }));
      if (!this.queryUpstream) return { meta: { count: entries.length, proposals: entries } };
      const body = await this.queryUpstream(path);
      const meta = body.meta;
      assert.ok(meta && Array.isArray(meta.proposals), 'Upstream fixture must return metadata');
      const proposals = [
        ...entries, ...meta.proposals.filter(entry => !this.proposals.has(entry.proposal)),
      ];
      return { meta: { ...meta, count: Math.max(meta.count, proposals.length), proposals } };
    }
    const match = /^\/dao\/proposals\/(\d+)$/.exec(path);
    assert.ok(match, `Unsupported fixture read: ${path}`);
    const proposal = this.proposals.get(Number(match[1]));
    if (proposal) return { proposal };
    assert.ok(this.queryUpstream, `Unknown fixture proposal: ${path}`);
    return this.queryUpstream(path);
  };
}
