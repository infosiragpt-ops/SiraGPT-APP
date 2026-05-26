#!/usr/bin/env python3
"""CrewAI bridge for SirAGPT multi-agent orchestration."""
import argparse, json, os
try:
    from crewai import Agent, Task, Crew, Process
    CREWAI_AVAILABLE = True
except ImportError:
    CREWAI_AVAILABLE = False

def run_workflow(input_path, output_path):
    if not CREWAI_AVAILABLE:
        with open(output_path, 'w') as f:
            json.dump({"error": "crewai Python package not installed"}, f)
        return
    with open(input_path, 'r') as f:
        config = json.load(f)
    agents_cfg = config.get('agents', [])
    task_desc = config.get('task', '')
    mode = config.get('mode', 'sequential')
    model = os.environ.get('SIRAGPT_CREWAI_MODEL', 'gpt-4o-mini')
    process = Process.sequential if mode == 'sequential' else Process.hierarchical
    crew_agents = [Agent(role=ag.get('role', f'Agent {i+1}'), goal=ag.get('goal', 'Complete task'), backstory=ag.get('backstory', 'You are helpful.'), llm=model, verbose=False) for i, ag in enumerate(agents_cfg)]
    task = Task(description=task_desc, expected_output=config.get('expected_output', 'A comprehensive response'), agent=crew_agents[0] if crew_agents else None)
    crew = Crew(agents=crew_agents, tasks=[task], process=process, verbose=False)
    try:
        result_text = crew.kickoff()
        result = {"output": str(result_text), "agents_used": len(crew_agents), "success": True}
    except Exception as e:
        result = {"error": str(e), "success": False}
    with open(output_path, 'w') as f:
        json.dump(result, f)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    run_workflow(args.input, args.output)
