'use strict';

const { z } = require('zod');
const workspaceStore = require('../../cowork/workspace-store');
const controlPlane = require('../../cowork/control-plane');
const scheduler = require('../../cowork/scheduler');

function requireContext(ctx) {
  const prisma = ctx?.prisma;
  const userId = ctx?.userId;
  const workspaceId = ctx?.workspaceId || ctx?.coworkWorkspaceId;
  if (!prisma || !userId || !workspaceId) {
    const error = new Error('Cowork workspace context is unavailable for this turn.');
    error.code = 'cowork_context_missing';
    throw error;
  }
  return {
    prisma,
    userId: String(userId),
    workspaceId: String(workspaceId),
    chatId: ctx?.chatId ? String(ctx.chatId) : null,
    runId: ctx?.coworkRunId ? String(ctx.coworkRunId) : null,
  };
}

function readVersions(ctx) {
  if (!ctx._coworkReadVersions || !(ctx._coworkReadVersions instanceof Map)) {
    ctx._coworkReadVersions = new Map();
  }
  return ctx._coworkReadVersions;
}

async function auditFile(ctx, action, file, inputSummary = null) {
  const context = requireContext(ctx);
  await controlPlane.appendAudit(context.prisma, {
    userId: context.userId,
    workspaceId: context.workspaceId,
    runId: context.runId,
    action,
    targetType: 'cowork_file',
    targetId: file?.id || file?.path || null,
    inputSummary,
    resultSummary: file?.path
      ? `${file.path}@${file.currentVersion || file.version || ''}`
      : null,
  });
}

function workspaceTools() {
  return [
    {
      name: 'ws_read',
      description: [
        'Read a file from the current Cowork workspace and return its content plus immutable version number.',
        'Always call this before ws_edit, before overwriting an existing file with ws_write, or before deleting/moving a file.',
      ].join(' '),
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        version: z.number().int().positive().optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Leyendo ${args.path}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const file = await workspaceStore.readFile(context.prisma, {
          ...context,
          filePath: args.path,
          version: args.version,
        });
        readVersions(ctx).set(file.path, file.currentVersion);
        await auditFile(ctx, 'cowork.file.read', file);
        return file;
      },
    },
    {
      name: 'ws_write',
      description: [
        'Create a new file or write a complete replacement into the current Cowork workspace.',
        'For a new path omit expectedVersion. For an existing path, call ws_read first and pass the returned currentVersion; stale writes are rejected.',
        'Use encoding=base64 for binary files.',
      ].join(' '),
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        content: z.string().max(35_000_000),
        encoding: z.enum(['utf8', 'base64']).optional(),
        mime: z.string().max(200).optional(),
        expectedVersion: z.number().int().nonnegative().optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Guardando ${args.path}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const normalized = workspaceStore.normalizeWorkspacePath(args.path);
        const remembered = readVersions(ctx).get(normalized);
        const expectedVersion = args.expectedVersion ?? remembered ?? null;
        const file = await workspaceStore.writeFile(context.prisma, {
          ...context,
          filePath: normalized,
          content: args.content,
          encoding: args.encoding || 'utf8',
          mime: args.mime,
          expectedVersion,
          authorRunId: context.runId,
          updatedBy: 'agent',
        });
        readVersions(ctx).set(file.path, file.currentVersion);
        await auditFile(ctx, 'cowork.file.write', file);
        ctx.onEvent?.({
          type: 'cowork_file_changed',
          workspaceId: context.workspaceId,
          file: {
            id: file.id,
            path: file.path,
            version: file.currentVersion,
            mime: file.mime,
            size: file.size,
          },
        });
        return {
          id: file.id,
          path: file.path,
          version: file.currentVersion,
          contentHash: file.contentHash,
          mime: file.mime,
          size: file.size,
          unchanged: Boolean(file.unchanged),
        };
      },
    },
    {
      name: 'ws_edit',
      description: [
        'Apply an exact search-and-replace edit to a UTF-8 text file in the current workspace.',
        'You MUST call ws_read first in this run. The edit fails if another actor changed the file after that read.',
      ].join(' '),
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        search: z.string().min(1).max(500_000),
        replace: z.string().max(500_000),
        replaceAll: z.boolean().optional(),
        expectedVersion: z.number().int().positive().optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Editando ${args.path}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const normalized = workspaceStore.normalizeWorkspacePath(args.path);
        const remembered = readVersions(ctx).get(normalized);
        const expectedVersion = args.expectedVersion ?? remembered;
        if (!expectedVersion) {
          const error = new workspaceStore.CoworkWorkspaceError(
            'workspace_read_required',
            `Call ws_read for ${normalized} before editing it.`,
            409,
          );
          throw error;
        }
        const current = await workspaceStore.readFile(context.prisma, {
          ...context,
          filePath: normalized,
        });
        if (current.encoding !== 'utf8') {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_binary_edit_unsupported',
            'ws_edit only supports UTF-8 text files. Use a format-specific document tool for binary files.',
            400,
          );
        }
        if (current.currentVersion !== Number(expectedVersion)) {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_version_conflict',
            `File changed after it was read. Expected version ${expectedVersion}; current version is ${current.currentVersion}.`,
            409,
            {
              path: normalized,
              expectedVersion,
              currentVersion: current.currentVersion,
            },
          );
        }
        const occurrences = current.content.split(args.search).length - 1;
        if (occurrences === 0) {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_edit_search_not_found',
            'The exact search text was not found. Read the file again and use an exact current fragment.',
            409,
          );
        }
        if (!args.replaceAll && occurrences > 1) {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_edit_ambiguous',
            `The search text appears ${occurrences} times. Supply a more specific search string or set replaceAll=true.`,
            409,
          );
        }
        const nextContent = args.replaceAll
          ? current.content.split(args.search).join(args.replace)
          : current.content.replace(args.search, args.replace);
        const file = await workspaceStore.writeFile(context.prisma, {
          ...context,
          filePath: normalized,
          content: nextContent,
          encoding: 'utf8',
          mime: current.mime,
          expectedVersion: Number(expectedVersion),
          authorRunId: context.runId,
          updatedBy: 'agent',
        });
        readVersions(ctx).set(file.path, file.currentVersion);
        await auditFile(ctx, 'cowork.file.edit', file, `Replaced ${occurrences} occurrence(s)`);
        ctx.onEvent?.({
          type: 'cowork_file_changed',
          workspaceId: context.workspaceId,
          file: {
            id: file.id,
            path: file.path,
            version: file.currentVersion,
            mime: file.mime,
            size: file.size,
          },
        });
        return {
          path: file.path,
          previousVersion: Number(expectedVersion),
          version: file.currentVersion,
          occurrences: args.replaceAll ? occurrences : 1,
          contentHash: file.contentHash,
        };
      },
    },
    {
      name: 'ws_glob',
      description: 'List files in the current Cowork workspace matching a glob such as **/*.md or reports/*.xlsx.',
      inputSchema: z.object({
        pattern: z.string().min(1).max(500).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Listando ${args.pattern || '**/*'}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        return {
          files: await workspaceStore.globFiles(context.prisma, {
            ...context,
            pattern: args.pattern || '**/*',
            limit: args.limit || 500,
          }),
        };
      },
    },
    {
      name: 'ws_grep',
      description: 'Search text across UTF-8 files in the current workspace and return matching path, line and text.',
      inputSchema: z.object({
        query: z.string().min(1).max(1000),
        pattern: z.string().min(1).max(500).optional(),
        ignoreCase: z.boolean().optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Buscando "${args.query}" en el workspace`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        return {
          matches: await workspaceStore.grepFiles(context.prisma, {
            ...context,
            query: args.query,
            pattern: args.pattern || '**/*',
            ignoreCase: args.ignoreCase !== false,
            limit: args.limit || 100,
          }),
        };
      },
    },
    {
      name: 'ws_move',
      description: 'Move or rename a workspace file. Call ws_read first; stale versions and target collisions are rejected.',
      inputSchema: z.object({
        from: z.string().min(1).max(500),
        to: z.string().min(1).max(500),
        expectedVersion: z.number().int().positive().optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Moviendo ${args.from} a ${args.to}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const from = workspaceStore.normalizeWorkspacePath(args.from);
        const expectedVersion = args.expectedVersion ?? readVersions(ctx).get(from);
        if (!expectedVersion) {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_read_required',
            `Call ws_read for ${from} before moving it.`,
            409,
          );
        }
        const moved = await workspaceStore.moveFile(context.prisma, {
          ...context,
          fromPath: from,
          toPath: args.to,
          expectedVersion,
        });
        readVersions(ctx).delete(from);
        readVersions(ctx).set(moved.path, moved.currentVersion);
        await auditFile(ctx, 'cowork.file.move', moved, `${from} -> ${moved.path}`);
        return { path: moved.path, version: moved.currentVersion };
      },
    },
    {
      name: 'ws_delete',
      description: 'Delete a workspace file. This is irreversible and always requires user approval. Call ws_read first.',
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        expectedVersion: z.number().int().positive().optional(),
      }).strict(),
      permissionTier: 'confirm',
      humanDescription: (args) => `Eliminar ${args.path} del workspace`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const normalized = workspaceStore.normalizeWorkspacePath(args.path);
        const expectedVersion = args.expectedVersion ?? readVersions(ctx).get(normalized);
        if (!expectedVersion) {
          throw new workspaceStore.CoworkWorkspaceError(
            'workspace_read_required',
            `Call ws_read for ${normalized} before deleting it.`,
            409,
          );
        }
        const deleted = await workspaceStore.deleteFile(context.prisma, {
          ...context,
          filePath: normalized,
          expectedVersion,
        });
        readVersions(ctx).delete(normalized);
        await auditFile(ctx, 'cowork.file.delete', deleted);
        return deleted;
      },
    },
  ];
}

function controlTools() {
  return [
    {
      name: 'update_checklist',
      description: 'Create or update the persistent checklist for this Cowork task. Keep exactly one item in_progress while work is active.',
      inputSchema: z.object({
        items: z.array(z.object({
          id: z.string().max(100).optional(),
          text: z.string().min(1).max(500),
          status: z.enum(['pending', 'in_progress', 'completed', 'blocked']),
          note: z.string().max(1000).optional(),
        }).strict()).min(1).max(100),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: () => 'Actualizando checklist',
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        if (!context.runId) throw new Error('No Cowork run is active.');
        const updated = await controlPlane.updateChecklist(context.prisma, {
          runId: context.runId,
          userId: context.userId,
          checklist: args.items,
        });
        ctx.onEvent?.({
          type: 'cowork_checklist',
          runId: context.runId,
          checklist: updated.checklist,
        });
        return { runId: context.runId, checklist: updated.checklist };
      },
    },
    {
      name: 'workspace_memory',
      description: [
        'Recall or remember durable facts that belong only to the current Cowork workspace.',
        'Use action=remember for stable project decisions and action=recall before relying on prior project context.',
        'Never use this tool for secrets, credentials, tokens, payment data or personal contact details.',
      ].join(' '),
      inputSchema: z.object({
        action: z.enum(['remember', 'recall']),
        fact: z.string().min(1).max(10_000).optional(),
        query: z.string().min(1).max(1000).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => (
        args.action === 'remember'
          ? 'Guardando memoria del workspace'
          : `Consultando memoria del workspace: ${args.query || ''}`
      ),
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        if (args.action === 'remember') {
          const fact = String(args.fact || '').trim();
          if (!fact) throw new Error('workspace_memory remember requires fact.');
          const existing = await context.prisma.coworkMemory.findFirst({
            where: {
              userId: context.userId,
              workspaceId: context.workspaceId,
              fact,
            },
          });
          const memory = existing || await context.prisma.coworkMemory.create({
            data: {
              userId: context.userId,
              workspaceId: context.workspaceId,
              fact,
              sourceChatId: context.chatId,
            },
          });
          await controlPlane.appendAudit(context.prisma, {
            userId: context.userId,
            workspaceId: context.workspaceId,
            runId: context.runId,
            action: 'cowork.memory.remembered',
            targetType: 'cowork_memory',
            targetId: memory.id,
            inputSummary: fact,
          });
          return { remembered: true, duplicate: Boolean(existing), memory: { id: memory.id, fact: memory.fact } };
        }

        const query = String(args.query || '').trim();
        if (!query) throw new Error('workspace_memory recall requires query.');
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20);
        const candidates = await context.prisma.coworkMemory.findMany({
          where: {
            userId: context.userId,
            workspaceId: context.workspaceId,
          },
          orderBy: { createdAt: 'desc' },
          take: 250,
        });
        const terms = new Set(
          query.toLocaleLowerCase('es').split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 2),
        );
        const ranked = candidates
          .map((memory, index) => {
            const haystack = String(memory.fact || '').toLocaleLowerCase('es');
            const matches = Array.from(terms).filter((term) => haystack.includes(term)).length;
            return { memory, matches, index };
          })
          .filter(({ matches }) => terms.size === 0 || matches > 0)
          .sort((left, right) => right.matches - left.matches || left.index - right.index)
          .slice(0, limit)
          .map(({ memory }) => ({
            id: memory.id,
            fact: memory.fact,
            createdAt: memory.createdAt,
          }));
        return { query, facts: ranked, workspaceId: context.workspaceId };
      },
    },
    {
      name: 'spawn_task',
      description: [
        'Launch a focused sub-task in parallel and return immediately with its Cowork run id.',
        'Use for independent research, coding, analysis or document work. Concurrency is limited by the user plan.',
      ].join(' '),
      inputSchema: z.object({
        prompt: z.string().min(3).max(20_000),
        title: z.string().min(1).max(80).optional(),
        thinking: z.enum(['low', 'medium', 'high']).optional(),
        maxSteps: z.number().int().min(1).max(160).optional(),
        maxCostUsd: z.number().positive().max(50).optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Lanzando sub-tarea: ${args.title || args.prompt.slice(0, 50)}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        if (!context.runId) throw new Error('No parent Cowork run is active.');
        const child = await controlPlane.createRun(context.prisma, {
          userId: context.userId,
          workspaceId: context.workspaceId,
          parentRunId: context.runId,
          prompt: args.prompt,
          kind: 'subtask',
          maxSteps: args.maxSteps,
          maxCostUsd: args.maxCostUsd,
          status: 'running',
        });
        setImmediate(async () => {
          try {
            const chat = await context.prisma.chat.create({
              data: {
                userId: context.userId,
                title: String(args.title || args.prompt).slice(0, 80),
                model: process.env.SIRAGPT_COWORK_HEADLESS_MODEL || 'gpt-4o-mini',
                coworkWorkspaceId: context.workspaceId,
              },
              select: { id: true },
            });
            await context.prisma.coworkRun.update({
              where: { id: child.id },
              data: { chatId: chat.id },
            });
            await context.prisma.message.create({
              data: {
                chatId: chat.id,
                role: 'USER',
                content: args.prompt,
                metadata: { coworkRunId: child.id, parentRunId: context.runId },
              },
            });
            const { runCoworkHeadless } = require('../../cowork/headless-runner');
            const result = await runCoworkHeadless(context.prisma, {
              run: { ...child, chatId: chat.id },
              chatId: chat.id,
              prompt: args.prompt,
              thinking: args.thinking || 'low',
              source: `cowork-subtask:${context.runId}`,
            });
            await context.prisma.message.create({
              data: {
                chatId: chat.id,
                role: 'ASSISTANT',
                content: String(result?.answer || '(No answer)'),
                metadata: {
                  coworkRunId: child.id,
                  parentRunId: context.runId,
                  stoppedReason: result?.stoppedReason || null,
                },
              },
            });
            await controlPlane.finishRun(context.prisma, {
              runId: child.id,
              userId: context.userId,
              status: /cancel|budget_exhausted/i.test(String(result?.stoppedReason || ''))
                ? 'cancelled'
                : 'completed',
              lastEvent: result?.stoppedReason || 'Sub-task completed',
            });
          } catch (error) {
            await controlPlane.finishRun(context.prisma, {
              runId: child.id,
              userId: context.userId,
              status: 'failed',
              lastEvent: error.message,
            }).catch(() => {});
          }
        });
        ctx.onEvent?.({
          type: 'cowork_task_spawned',
          parentRunId: context.runId,
          run: {
            id: child.id,
            status: child.status,
            prompt: child.prompt,
            maxSteps: child.maxSteps,
            maxCostUsd: child.maxCostUsd,
          },
        });
        return {
          spawned: true,
          runId: child.id,
          parentRunId: context.runId,
          status: child.status,
        };
      },
    },
    {
      name: 'schedule_task',
      description: 'Schedule a recurring Cowork task with a cron expression and timezone. The task runs headlessly and delivers to chat, email or Telegram.',
      inputSchema: z.object({
        prompt: z.string().min(3).max(20_000),
        cronExpr: z.string().min(5).max(100),
        tz: z.string().min(1).max(100).optional(),
        deliver: z.enum(['chat', 'email', 'telegram']).optional(),
        maxSteps: z.number().int().min(1).max(160).optional(),
        maxCostUsd: z.number().positive().max(50).optional(),
      }).strict(),
      permissionTier: 'confirm',
      humanDescription: (args) => `Programar tarea recurrente: ${args.cronExpr}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const task = await scheduler.createScheduledTask(context.prisma, {
          userId: context.userId,
          workspaceId: context.workspaceId,
          prompt: args.prompt,
          cronExpr: args.cronExpr,
          tz: args.tz || 'UTC',
          deliver: args.deliver || 'chat',
          maxSteps: args.maxSteps,
          maxCostUsd: args.maxCostUsd,
          createdFrom: 'agent_tool',
        });
        await controlPlane.appendAudit(context.prisma, {
          userId: context.userId,
          workspaceId: context.workspaceId,
          runId: context.runId,
          action: 'cowork.schedule.created',
          targetType: 'scheduled_agent_task',
          targetId: task.id,
          inputSummary: args.prompt,
          metadata: {
            cronExpr: task.cronExpr,
            tz: task.tz,
            deliver: task.deliver,
          },
        });
        return task;
      },
    },
    {
      name: 'browse_page',
      description: [
        'Open a public web page in a visible Chromium renderer, extract rendered text and save a screenshot in the current workspace.',
        'Private, loopback, local and cloud-metadata addresses are blocked.',
      ].join(' '),
      inputSchema: z.object({
        url: z.string().url().max(4000),
        screenshotPath: z.string().min(1).max(500).optional(),
      }).strict(),
      permissionTier: 'auto',
      humanDescription: (args) => `Abriendo ${args.url}`,
      execute: async (args, ctx) => {
        const context = requireContext(ctx);
        const { assertSafeUrl } = require('./web-fetch-tool');
        const { resolveAndAssertSafe } = require('../../connectors/web-fetch');
        const validatedHosts = new Set();
        const validateBrowserUrl = async (rawUrl) => {
          const target = assertSafeUrl(rawUrl);
          const hostname = target.hostname.toLowerCase();
          if (!validatedHosts.has(hostname)) {
            await resolveAndAssertSafe(hostname);
            validatedHosts.add(hostname);
          }
          return target;
        };
        const parsed = await validateBrowserUrl(args.url);
        const { createBrowserSession } = require('../../research-agent')._internal;
        const browser = createBrowserSession({
          totalBudgetMs: 45_000,
          validateUrl: validateBrowserUrl,
        });
        try {
          const page = await browser.visit(parsed.toString(), {
            perPageNavMs: 20_000,
            perPageRenderMs: 5_000,
            screenshotMaxBytes: 2 * 1024 * 1024,
          });
          if (page.error && !page.text && !page.screenshotBase64) {
            throw new Error(`Browser failed: ${page.error}`);
          }
          let screenshot = null;
          if (page.screenshotBase64) {
            const defaultName = `.browser/screenshots/${Date.now()}-${parsed.hostname.replace(/[^A-Za-z0-9.-]+/g, '_')}.png`;
            const file = await workspaceStore.writeFile(context.prisma, {
              ...context,
              filePath: args.screenshotPath || defaultName,
              content: page.screenshotBase64,
              encoding: 'base64',
              mime: 'image/png',
              expectedVersion: 0,
              authorRunId: context.runId,
              updatedBy: 'agent',
            });
            screenshot = {
              id: file.id,
              path: file.path,
              version: file.currentVersion,
              mime: file.mime,
              size: file.size,
            };
            ctx.onEvent?.({
              type: 'cowork_browser_snapshot',
              runId: context.runId,
              url: page.url,
              screenshot,
            });
          }
          await controlPlane.appendAudit(context.prisma, {
            userId: context.userId,
            workspaceId: context.workspaceId,
            runId: context.runId,
            action: 'cowork.browser.visited',
            targetType: 'url',
            targetId: page.url,
            resultSummary: page.title || page.error || 'Page rendered',
            metadata: { statusCode: page.statusCode, screenshotPath: screenshot?.path || null },
          });
          return {
            url: page.url,
            statusCode: page.statusCode,
            title: page.title,
            text: page.text,
            screenshot,
            warning: page.error || null,
          };
        } finally {
          await browser.close();
        }
      },
    },
  ];
}

function buildCoworkTools() {
  return [...workspaceTools(), ...controlTools()];
}

module.exports = {
  buildCoworkTools,
  workspaceTools,
  controlTools,
  requireContext,
};
