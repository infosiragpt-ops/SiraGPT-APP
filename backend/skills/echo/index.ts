import type { SkillContext, SkillModule } from '../../src/skills/types.ts';

interface EchoArgs {
  message: string;
}

const skill: SkillModule = {
  tools: {
    echo(args: unknown, ctx: SkillContext) {
      const { message } = args as EchoArgs;
      ctx.logger.debug('echo invoked', { length: message?.length ?? 0 });
      return { message };
    },
  },
};

export default skill;
