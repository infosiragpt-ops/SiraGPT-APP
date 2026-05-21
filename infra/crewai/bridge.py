#!/usr/bin/env python3
"""
CrewAI bridge for SirAGPT multi-agent orchestration.

Reads a JSON input file { agents, task, mode }, executes the
CrewAI workflow, and writes the result to an output JSON file.

Usage:
    python3 bridge.py --input input.json --output output.json

Env:
    SIRAGPT_CREWAI_MODEL — model name (default: gpt-4o-mini)
    OPENAI_API_KEY — required for CrewAI LLM calls
"""

import argparse
import json
import os
import sys

try:
    from crewai import Agent, Task, Crew, Process
    CREWAI_AVAILABLE = True
except ImportError:
    CREWAI_AVAILABLE = False


def run_workflow(input_path, output_path):
    if not CREWAI_AVAILABLE:
        result = {"error": "crewai Python package not installed", "available": False}
        with open(output_path, 'w') as f:
            json.dump(result, f)
        return

    with open(input_path, 'r') as f:
        config = json.load(f)

    agents_config = config.get('agents', [])
    task_desc = config.get('task', '')
    mode = config.get('mode', 'sequential')

    model = os.environ.get('SIRAGPT_CREWAI_MODEL', 'gpt-4o-mini')
    process = Process.sequential if mode == 'sequential' else Process.hierarchical

    crew_agents = []
    for i, ag in enumerate(agents_config):
        agent = Agent(
            role=ag.get('role', f'Agent {i+1}'),
            goal=ag.get('goal', 'Complete the assigned task'),
            backstory=ag.get('backstory', 'You are a helpful AI assistant.'),
            llm=model,
            verbose=False,
        )
        crew_agents.append(agent)

    task = Task(
        description=task_desc,
        expected_output=config.get('expected_output', 'A comprehensive response'),
        agent=crew_agents[0] if crew_agents else None,
    )

    crew = Crew(
        agents=crew_agents,
        tasks=[task],
        process=process,
        verbose=False,
    )

    try:
        result_text = crew.kickoff()
        result = {"output": str(result_text), "agents_used": len(crew_agents), "mode": mode, "success": True}
    except Exception as e:
        result = {"error": str(e), "agents_used": len(crew_agents), "mode": mode, "success": False}

    with open(output_path, 'w') as f:
        json.dump(result, f)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='CrewAI bridge for SirAGPT')
    parser.add_argument('--input', required=True, help='Input JSON file')
    parser.add_argument('--output', required=True, help='Output JSON file')
    args = parser.parse_args()
    run_workflow(args.input, args.output)
