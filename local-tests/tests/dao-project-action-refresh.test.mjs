import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import * as dao from '../dao.js';

const appSource = await readFile(new URL('../app.js', import.meta.url), 'utf8');
const helpersStart = appSource.indexOf('function isDaoProjectContractor(');
const helpersEnd = appSource.indexOf('function formatDaoClaimWindowLabel(', helpersStart);
const modalStart = appSource.indexOf('class ProposalInfoModal {');
const modalEnd = appSource.indexOf('const proposalInfoModal = new ProposalInfoModal();', modalStart);
assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && modalStart >= 0 && modalEnd > modalStart);
const modalSource = `${appSource.slice(helpersStart, helpersEnd)}\n${appSource.slice(modalStart, modalEnd)}
  ({
    ProposalInfoModal,
    getDaoProjectMilestoneLifecycleActions,
    getDaoProjectCloseoutActions: typeof getDaoProjectCloseoutActions === 'function'
      ? getDaoProjectCloseoutActions : null,
  });`;

const MEMBER = 'a'.repeat(40);
const OTHER_MEMBER = 'b'.repeat(40);
const CONTRACTOR = 'c'.repeat(40);
const PROPOSAL_ACCOUNT = 'd'.repeat(64);
const NONCE = 'e'.repeat(64);
const PENDING_CONTRACTOR = 'f'.repeat(40);
const NEW_CONTRACTOR = '1'.repeat(40);

function milestone(status = 'pending', proposedTime = null) {
  return { status: { key: status }, proposedTime, endorsedTime: [], terminateVotes: [] };
}

function proposal(milestones = [milestone(), milestone()]) {
  return {
    number: 12,
    nonce: NONCE,
    accountId: PROPOSAL_ACCOUNT,
    proposalType: 'project',
    status: 'executing',
    committeeAddresses: [MEMBER, OTHER_MEMBER],
    project: {
      kind: 'available',
      address: CONTRACTOR,
      proposedAddress: null,
      endorsedAddress: [],
      balanceWei: 100n,
      endTime: null,
      milestones,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(displayedProposal, refresh = async () => structuredClone(displayedProposal)) {
  const signed = [];
  const rendered = [];
  const warnings = [];
  const refreshCalls = [];
  let active = true;
  let cachedProposal = displayedProposal;
  const context = {
    ...dao,
    console: { warn() {} },
    myAccount: { keys: { address: MEMBER } },
    network: { netid: 'localnet' },
    getDaoCurrentAccountAddress: () => context.myAccount?.keys?.address || '',
    getTransactionTimestamp: () => 1_000,
    getEffectiveDaoState: (value) => value.status,
    getDaoProjectPresentation: (value) => value.project,
    isDaoProposalCommitteeMember: (value, address) => value.committeeAddresses.includes(address),
    formatDaoTimestamp: String,
    showToast(message, _duration, kind) {
      if (kind === 'warning') warnings.push(message);
      return 1;
    },
    hideToast() {},
    window: { confirm: () => true },
    daoRepo: {
      ...dao.daoRepo,
      async refreshProposal(number) {
        refreshCalls.push({ number, locked: modal.isSubmitting });
        const fresh = await refresh();
        if (fresh) cachedProposal = fresh;
        return fresh;
      },
      getProposalById: () => cachedProposal,
    },
  };
  const {
    ProposalInfoModal,
    getDaoProjectMilestoneLifecycleActions,
    getDaoProjectCloseoutActions,
  } = vm.runInNewContext(modalSource, context);
  const getActions = (value) => [
    ...getDaoProjectMilestoneLifecycleActions(value, context.getDaoCurrentAccountAddress()),
    ...(getDaoProjectCloseoutActions?.(value, context.getDaoCurrentAccountAddress(), 1_000) || []),
  ];
  const modal = new ProposalInfoModal();
  const addressInput = { value: '', focus() {} };
  const element = {
    classList: { contains: () => active },
    querySelector: (selector) => selector.includes('action-address') ? addressInput : null,
  };
  modal.modal = element;
  modal.lifecycleActionSection = element;
  modal._currentProposalId = `${displayedProposal.number}_${displayedProposal.nonce}`;
  modal.currentLifecycleActions = getActions(displayedProposal);
  modal.isSubmitting = false;
  modal.isDaoActionPending = () => false;
  modal.setSubmitting = (value) => { modal.isSubmitting = value; };
  modal.updateSubmitButtons = () => {};
  modal.recordAcceptedDaoAction = () => {};
  modal.renderProposal = (fresh) => {
    rendered.push(fresh);
    modal.currentLifecycleActions = getActions(fresh);
    addressInput.value = '';
  };
  modal.submitDaoTransaction = async (transaction) => {
    signed.push(transaction);
    return { txid: `signed-${signed.length}`, result: { success: true } };
  };
  return {
    modal,
    context,
    signed,
    warnings,
    rendered,
    refreshCalls,
    addressInput,
    close: () => { active = false; },
    action: (kind, addressRequired) => modal.currentLifecycleActions.find((action) => (
      action.kind === kind
      && (addressRequired === undefined || Boolean(action.addressRequired) === addressRequired)
    )),
  };
}

for (const [kind, status] of [
  ['project_milestone_start', 'pending'],
  ['project_milestone_end', 'executing'],
]) {
  for (const proposedTime of [null, 900]) {
    test(`${kind}: unchanged ${proposedTime === null ? 'proposal' : 'endorsement'} refreshes before signing`, async () => {
      const h = harness(proposal([milestone(status, proposedTime)]));
      const action = h.action(kind);
      await h.modal.handleLifecycleActionSubmit(action);

      assert.equal(h.signed.length, 1, h.warnings.join('\n'));
      assert.equal(h.refreshCalls.length, 1);
      assert.equal(h.refreshCalls[0].locked, true);
      assert.equal(h.signed[0].type, `dao_${kind}`);
      assert.equal(h.signed[0].milestoneNumber, 1);
      assert.equal(h.signed[0].proposedTime, proposedTime === null ? 1_000 : undefined);
      assert.equal(h.signed[0].expectedProposedTime, proposedTime === null ? undefined : proposedTime);
      assert.equal(h.modal.isSubmitting, false);
    });
  }

  test(`${kind}: does not retarget the next milestone after the displayed one finishes`, async () => {
    const displayed = proposal([milestone(status), milestone()]);
    const fresh = proposal([milestone('terminated'), milestone(status)]);
    const h = harness(displayed, async () => fresh);

    await h.modal.handleLifecycleActionSubmit(h.action(kind));

    assert.equal(h.signed.length, 0);
    assert.equal(h.rendered[0], fresh);
    assert.equal(h.modal.isSubmitting, false);
  });

  for (const [oldTime, newTime] of [[null, 900], [900, null], [900, 901]]) {
    test(`${kind}: requires renewed review when proposed time changes from ${oldTime} to ${newTime}`, async () => {
      const displayed = proposal([milestone(status, oldTime)]);
      const fresh = proposal([milestone(status, newTime)]);
      const h = harness(displayed, async () => fresh);

      await h.modal.handleLifecycleActionSubmit(h.action(kind));

      assert.equal(h.signed.length, 0);
      assert.equal(h.rendered[0], fresh);
      assert.equal(h.modal.isSubmitting, false);
    });
  }
}

test('does not submit an endorsement that was already recorded during refresh', async () => {
  const displayed = proposal([milestone('pending', 900)]);
  const fresh = structuredClone(displayed);
  fresh.project.milestones[0].endorsedTime = [MEMBER];
  const h = harness(displayed, async () => fresh);

  await h.modal.handleLifecycleActionSubmit(h.action('project_milestone_start'));

  assert.equal(h.signed.length, 0);
  assert.equal(h.rendered[0], fresh);
});

test('does not submit after committee membership is lost', async () => {
  const displayed = proposal([milestone('pending', 900)]);
  const fresh = structuredClone(displayed);
  fresh.committeeAddresses = [OTHER_MEMBER];
  const h = harness(displayed, async () => fresh);

  await h.modal.handleLifecycleActionSubmit(h.action('project_milestone_start'));

  assert.equal(h.signed.length, 0);
});

test('a duplicate click while refresh is pending starts only one submission', async () => {
  const refresh = deferred();
  const displayed = proposal();
  const h = harness(displayed, () => refresh.promise);
  const action = h.action('project_milestone_start');
  const first = h.modal.handleLifecycleActionSubmit(action);

  assert.equal(h.modal.isSubmitting, true);
  await h.modal.handleLifecycleActionSubmit(action);
  assert.equal(h.refreshCalls.length, 1);
  assert.equal(h.signed.length, 0);
  refresh.resolve(structuredClone(displayed));
  await first;

  assert.equal(h.signed.length, 1, h.warnings.join('\n'));
  assert.equal(h.modal.isSubmitting, false);
});

for (const [label, refresh] of [
  ['missing data', async () => null],
  ['network failure', async () => { throw new Error('Network unavailable'); }],
]) {
  test(`${label} does not fall back to cached proposal data`, async () => {
    const h = harness(proposal(), refresh);

    await h.modal.handleLifecycleActionSubmit(h.action('project_milestone_start'));

    assert.equal(h.signed.length, 0);
    assert.equal(h.refreshCalls.length, 1);
    assert.equal(h.modal.isSubmitting, false);
    assert.ok(h.warnings.length > 0);
  });
}

for (const [label, change] of [
  ['wallet account', (h) => { h.context.myAccount.keys.address = OTHER_MEMBER; }],
  ['network', (h) => { h.context.network.netid = 'different-network'; }],
  ['open proposal', (h) => { h.modal._currentProposalId = `13_${NONCE}`; }],
  ['modal visibility', (h) => { h.close(); }],
]) {
  test(`changing ${label} during refresh cancels the submission`, async () => {
    const refresh = deferred();
    const displayed = proposal();
    const h = harness(displayed, () => refresh.promise);
    const submission = h.modal.handleLifecycleActionSubmit(h.action('project_milestone_start'));

    change(h);
    refresh.resolve(structuredClone(displayed));
    await submission;

    assert.equal(h.signed.length, 0);
    assert.equal(h.modal.isSubmitting, false);
  });
}

test('a pending transaction discovered during refresh prevents another signature', async () => {
  const refresh = deferred();
  const displayed = proposal();
  const h = harness(displayed, () => refresh.promise);
  const submission = h.modal.handleLifecycleActionSubmit(h.action('project_milestone_start'));

  h.modal.isDaoActionPending = () => true;
  refresh.resolve(structuredClone(displayed));
  await submission;

  assert.equal(h.signed.length, 0);
  assert.equal(h.modal.isSubmitting, false);
});

if (appSource.includes('function getDaoProjectCloseoutActions(')) {
  for (const [label, pendingAddress, addressRequired] of [
    ['propose', null, true],
    ['replace', PENDING_CONTRACTOR, true],
    ['endorse', PENDING_CONTRACTOR, false],
  ]) {
    test(`unchanged contractor ${label} refreshes and signs the intended action`, async () => {
      const displayed = proposal();
      displayed.project.proposedAddress = pendingAddress;
      const h = harness(displayed);
      h.addressInput.value = `0x${NEW_CONTRACTOR}`;

      await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', addressRequired));

      assert.equal(h.signed.length, 1, h.warnings.join('\n'));
      assert.equal(h.refreshCalls.length, 1);
      assert.equal(h.refreshCalls[0].locked, true);
      assert.equal(h.signed[0].type, 'dao_project_change_address');
      assert.equal(h.signed[0].proposedAddress, addressRequired ? `${NEW_CONTRACTOR}${'0'.repeat(24)}` : undefined);
      assert.equal(h.signed[0].expectedProposedAddress, addressRequired ? undefined : `${PENDING_CONTRACTOR}${'0'.repeat(24)}`);
      assert.equal(h.modal.isSubmitting, false);
    });

    test(`contractor ${label} cannot silently retarget a changed pending address`, async () => {
      const displayed = proposal();
      displayed.project.proposedAddress = pendingAddress;
      const fresh = structuredClone(displayed);
      fresh.project.proposedAddress = '2'.repeat(40);
      const h = harness(displayed, async () => fresh);
      h.addressInput.value = NEW_CONTRACTOR;

      await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', addressRequired));

      assert.equal(h.signed.length, 0);
      assert.equal(h.rendered[0], fresh);
    });

    test(`contractor ${label} stops when the current contractor changes`, async () => {
      const displayed = proposal();
      displayed.project.proposedAddress = pendingAddress;
      const fresh = structuredClone(displayed);
      fresh.project.address = '2'.repeat(40);
      const h = harness(displayed, async () => fresh);
      h.addressInput.value = NEW_CONTRACTOR;

      await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', addressRequired));

      assert.equal(h.signed.length, 0);
    });
  }

  for (const addressRequired of [false, true]) {
    test(`cleared pending address cancels ${addressRequired ? 'replacement' : 'endorsement'}`, async () => {
      const displayed = proposal();
      displayed.project.proposedAddress = PENDING_CONTRACTOR;
      const fresh = structuredClone(displayed);
      fresh.project.proposedAddress = null;
      const h = harness(displayed, async () => fresh);
      h.addressInput.value = NEW_CONTRACTOR;

      await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', addressRequired));

      assert.equal(h.signed.length, 0);
    });
  }

  for (const [label, change] of [
    ['already recorded endorsement', (fresh) => { fresh.project.endorsedAddress = [MEMBER]; }],
    ['lost committee membership', (fresh) => { fresh.committeeAddresses = [OTHER_MEMBER]; }],
  ]) {
    test(`${label} cancels contractor endorsement`, async () => {
      const displayed = proposal();
      displayed.project.proposedAddress = PENDING_CONTRACTOR;
      const fresh = structuredClone(displayed);
      change(fresh);
      const h = harness(displayed, async () => fresh);

      await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', false));

      assert.equal(h.signed.length, 0);
    });
  }

  test('contractor replacement retains the captured address when DOM inputs change during refresh', async () => {
    const refresh = deferred();
    const displayed = proposal();
    displayed.project.proposedAddress = PENDING_CONTRACTOR;
    const h = harness(displayed, () => refresh.promise);
    h.addressInput.value = NEW_CONTRACTOR;
    const submission = h.modal.handleLifecycleActionSubmit(h.action('project_change_address', true));

    h.modal.currentLifecycleActions = [];
    h.addressInput.value = '';
    refresh.resolve(structuredClone(displayed));
    await submission;

    assert.equal(h.signed.length, 1, h.warnings.join('\n'));
    assert.equal(h.signed[0].proposedAddress, `${NEW_CONTRACTOR}${'0'.repeat(24)}`);
  });

  test('contractor endorsement fails closed when refresh provides no proposal', async () => {
    const displayed = proposal();
    displayed.project.proposedAddress = PENDING_CONTRACTOR;
    const h = harness(displayed, async () => null);

    await h.modal.handleLifecycleActionSubmit(h.action('project_change_address', false));

    assert.equal(h.signed.length, 0);
    assert.equal(h.modal.isSubmitting, false);
    assert.ok(h.warnings.length > 0);
  });
}
