# Host Bridge Contract

## Purpose

This document describes the generic capabilities that a remote host bridge may expose to changxian-agent.

## Core Capabilities

A host bridge may implement any subset of the following:

- `submit_task`: start a new task from text or structured input
- `stream_progress`: show partial progress updates
- `show_status`: return current task state
- `cancel_task`: stop a running task
- `reset_session`: start a fresh conversation/session
- `set_workdir`: change the working directory
- `set_permissions`: switch execution safety or permission tiers
- `set_runtime_option`: toggle runtime behavior
- `schedule_task`: create one-time or recurring jobs
- `attach_media`: provide images or files as task input

## Agent Behavior

When using a remote host bridge:

- prefer short progress-aware replies
- avoid assuming a full terminal UI
- distinguish between immediate actions and persistent settings
- keep scheduled prompts stable and explicit
- honor host limitations when a capability is absent

## Scheduling

If `schedule_task` is available, the host may support:

- one-time delayed jobs
- interval jobs
- cron-like recurring jobs
- manual immediate runs of an existing saved job
- pausing and resuming jobs
- removing jobs

## State Cooperation

If the host persists durable state, remote-control flows should cooperate with:

- memory management
- role management
- current working directory
- session continuity
