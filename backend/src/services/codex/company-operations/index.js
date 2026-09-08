'use strict';

const inbox = require('./inbox-triage');
const social = require('./social-triage');
const sales = require('./sales-pipeline');
const actions = require('./external-actions');
const policy = require('./external-action-policy');

async function getOperationsSnapshot({ prisma, project, take = 20 }) {
  const limit = Math.max(1, Math.min(100, Number(take) || 20));
  const [leads, inboxItems, externalActions, leadCount, pendingInbox, pendingActions] = await Promise.all([
    prisma.codexCompanyLead.findMany({
      where: { projectId: project.id, userId: project.userId },
      orderBy: [{ score: 'desc' }, { updatedAt: 'desc' }],
      take: limit,
    }),
    prisma.codexCompanyInboxItem.findMany({
      where: { projectId: project.id, userId: project.userId },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
    prisma.codexExternalAction.findMany({
      where: { projectId: project.id, userId: project.userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.codexCompanyLead.count({ where: { projectId: project.id, userId: project.userId } }),
    prisma.codexCompanyInboxItem.count({
      where: {
        projectId: project.id,
        userId: project.userId,
        status: { in: ['pending_review', 'drafted', 'error'] },
      },
    }),
    prisma.codexExternalAction.count({
      where: {
        projectId: project.id,
        userId: project.userId,
        status: { in: ['pending_review', 'approved', 'error'] },
      },
    }),
  ]);
  return {
    counts: { leads: leadCount, pendingInbox, pendingActions },
    leads,
    inboxItems,
    actions: externalActions,
  };
}

module.exports = {
  ...actions,
  ...policy,
  ...sales,
  ...inbox,
  ...social,
  getOperationsSnapshot,
};
