export type ExplainTopic = {
  id: string;
  label: string;
  short: string;
  summary?: string[];
  sections: {
    title: string;
    lines: string[];
    visualLines?: string[];
  }[];
};

export const EXPLAIN_TOPICS: ExplainTopic[] = [
  {
    id: "overview",
    label: "What this is",
    short: "study overview",
    summary: [
      "One run = one scenario + one condition + one roster.",
      "The platform compares how setup changes group belief over time.",
    ],
    sections: [
      {
        title: "Purpose",
        lines: [
          "This testbed is for running repeatable multi agent experiments.",
          "A run combines one scenario, one condition, and one agent population.",
          "The goal is to compare how different interaction setups change what the group believes over time.",
        ],
      },
      {
        title: "What changes across runs",
        lines: [
          "Scenarios change the claims, evidence, and corrections.",
          "Conditions change memory rules, interaction mode, topology, and correction settings.",
          "Run configs choose the agents, seed, round limit, and model budget.",
        ],
      },
    ],
  },
  {
    id: "safety-space",
    label: "Multi-agent safety",
    short: "where this fits",
    summary: [
      "This project studies epistemic failure in small LLM societies.",
      "The focus is not one bad answer, but how groups keep false belief alive.",
    ],
    sections: [
      {
        title: "Broader safety space",
        visualLines: [
          "miscoordination   collusion   information gaps   trust",
          "        \\              |              /          ",
          "         \\             |             /           ",
          "             multi-agent safety as a system      ",
        ],
        lines: [
          "Recent work frames multi agent safety as a systems problem, not just a single model problem.",
          "The broader space includes miscoordination, conflict, collusion, information asymmetries, selection pressures, destabilising dynamics, commitment and trust, emergent agency, and multi agent security.",
          "That framing comes from Hammond et al., Multi-Agent Risks from Advanced AI, 2025.",
        ],
      },
      {
        title: "What Agent Society tests",
        visualLines: [
          "seed false claim -> shared memory -> retrieval -> repetition -> lock-in",
          "                                    \\-> correction may fail",
        ],
        lines: [
          "This project focuses on one narrower slice of that space: epistemic failure in small LLM societies.",
          "The main questions are how false claims spread, how shared memory changes group belief, when correction fails, and what helps recovery.",
          "This makes the testbed most useful for studying information asymmetries, destabilising dynamics, commitment and trust, and some forms of miscoordination.",
        ],
      },
      {
        title: "Main story",
        lines: [
          "A single false output is not the main problem here.",
          "The deeper problem is that agents build a shared epistemic environment through memory, retrieval, repetition, and correction.",
          "That environment can keep false belief alive even when later agents see better evidence.",
        ],
      },
      {
        title: "Paper source",
        lines: [
          "Hammond et al. (2025), Multi-Agent Risks from Advanced AI.",
          "arXiv: 2502.14143",
          "https://arxiv.org/pdf/2502.14143",
        ],
      },
    ],
  },
  {
    id: "modes",
    label: "Modes and backends",
    short: "memory vs chat",
    summary: [
      "Memory mode is the cleaner causal setup.",
      "Chat mode is the richer group discussion setup.",
    ],
    sections: [
      {
        title: "Memory mode",
        visualLines: [
          "[agent] -> read [memory notes] -> update claim stance -> write [new note]",
        ],
        lines: [
          "In the interface, a round means one unit of simulation time.",
          "In memory mode, one round means one agent turn.",
          "That agent reads memories, scores each claim, updates its stance, and may write new memory.",
          "This is the cleaner setup for studying propagation through shared or personal memory.",
        ],
      },
      {
        title: "Chat mode",
        visualLines: [
          "[agent] <-> [agent] <-> [agent]   across a topology each round",
        ],
        lines: [
          "In chat mode, one outer round is one group debate cycle.",
          "Inside that cycle, agents may still exchange several chat rounds with each other.",
          "What each agent sees depends on the topology, such as fully connected, star, chain, or ring.",
          "This is the better setup for studying group dynamics, convergence, and the physics style analyses.",
        ],
      },
      {
        title: "Flow legend",
        visualLines: [
          "memory flow",
          "[agent] -> [note] -> [shared pool] -> [agent]",
          "",
          "chat flow",
          "[agent] <-> [agent] <-> [agent]",
        ],
        lines: [
          "Memory flow means agents influence later agents by writing notes that can be retrieved later.",
          "Chat flow means agents influence each other through direct messages along a communication structure.",
        ],
      },
      {
        title: "Model types",
        lines: [
          "Heuristic agents use a fixed scoring rule, so runs are fast and easy to sweep.",
          "LLM agents use prompts and provider APIs, so runs are slower but closer to real reasoning.",
        ],
      },
    ],
  },
  {
    id: "run-order",
    label: "Study run order",
    short: "what to run first",
    summary: [
      "This is the clean run order for the current 10 study families.",
      "Start with the paper-facing pair, then move to scope checks, then mechanism-building pilots.",
    ],
    sections: [
      {
        title: "Run first",
        visualLines: [
          "1  -> study 1 memory rules",
          "1a -> study 1 GT verification",
          "2  -> study 2 correction policies",
        ],
        lines: [
          "These are the main paper-facing runs right now.",
          "Study 1 is the clean memory-only result under split evidence.",
          "Study 1a asks what changes when shared memory gets stronger or weaker GT checking.",
          "Study 2 shows what correction timing and strength do once the claim starts circulating.",
        ],
      },
      {
        title: "Run next",
        visualLines: [
          "3 -> study 7 private evidence",
          "4 -> study 8 source exit",
          "5 -> study 9 correction trust",
          "6 -> study 10 seeded false memory",
        ],
        lines: [
          "These are the strongest supporting studies for the current paper line.",
          "Study 7 makes the truth-distribution setting sharper.",
          "Study 8 tests whether the group record keeps the claim alive after the source leaves.",
          "Study 9 separates correction presence from correction uptake.",
          "Study 10 is the inherited-false-record stress line.",
        ],
      },
      {
        title: "Run after that",
        visualLines: [
          "7 -> study 4 population mix",
          "8 -> study 1 scaling",
          "9 -> study 1 model robustness",
          "10 -> study 3 topology",
        ],
        lines: [
          "These are scope and boundary checks.",
          "Population mix asks who is in the society.",
          "Scaling asks whether the pattern holds as the group grows.",
          "Model robustness asks whether the ranking changes across model families.",
          "Topology is valuable, but it is chat mode, so keep it separate from the main memory studies.",
        ],
      },
      {
        title: "Mechanism checks only",
        visualLines: [
          "pilot -> study 5 open discussion",
          "pilot -> study 6 truthful collusion",
          "legacy -> old study 1 memory mode",
          "legacy -> old study 2 timing subset",
        ],
        lines: [
          "These should not carry the main paper claim yet.",
          "Study 5 and study 6 are good for richer discourse and selective-steering checks.",
          "The two legacy manifests are still useful for quick sanity checks, but they are not the main study set anymore.",
        ],
      },
    ],
  },
  {
    id: "new-studies",
    label: "New studies 7-10",
    short: "private evidence, exit, trust, poisoning",
    summary: [
      "These are the next study families added after the first six studies.",
      "They push the platform toward information asymmetry, persistence, trust, and security questions.",
    ],
    sections: [
      {
        title: "Study 7: Private evidence split",
        visualLines: [
          "[misleading clue]   [strong correction]   [fraud/retraction]",
          "      ♦ r1               ◆ o1                 ◆ r2",
        ],
        lines: [
          "Truth is split across agents so no single agent begins with the whole picture.",
          "The main comparison is whether personal memory, shared memory, or verification changes the group's ability to recover the truth.",
        ],
      },
      {
        title: "Study 8: Source exit and observer",
        visualLines: [
          "[♦ source] -> [shared memory] -> [group]",
          "    exits early          observer may read only",
        ],
        lines: [
          "This tests whether a false claim keeps spreading after the original source disappears.",
          "It also tests whether a read-only observer changes the later memory environment without directly writing into it.",
        ],
      },
      {
        title: "Study 9: Correction trust",
        visualLines: [
          "same correction event",
          "low trust -> weaker recovery",
          "high trust -> stronger recovery",
        ],
        lines: [
          "This holds the correction event fixed and changes only how much agents trust it.",
          "The goal is to separate correction availability from correction uptake.",
        ],
      },
      {
        title: "Study 10: Memory poisoning",
        visualLines: [
          "low:  1 seeded false note",
          "mid:  2 seeded false notes",
          "high: 4 repeated false notes",
        ],
        lines: [
          "This varies how much false memory is seeded at the start of the run.",
          "The main question is how much poisoning is needed before later correction stops working well.",
        ],
      },
    ],
  },
  {
    id: "metrics",
    label: "How to read metrics",
    short: "what the numbers mean",
    summary: [
      "Most metrics answer one question: how much false belief spread, and did the group recover?",
    ],
    sections: [
      {
        title: "Core outcomes",
        visualLines: [
          "endorse rate   reject rate   uncertain rate   truth distance",
        ],
        lines: [
          "Endorsement rate is the share of agents endorsing the focus claim.",
          "Reject rate is the share rejecting it.",
          "Uncertain rate is the share still undecided.",
          "Truth distance is how far the full belief state is from the scenario truth labels.",
        ],
      },
      {
        title: "Trajectory numbers",
        lines: [
          "Consensus now is the share in the largest stance group at the final round.",
          "Consensus peak is the highest version of that number during the run.",
          "Net endorsement is endorsement share minus reject share.",
          "Mean confidence is the average confidence on the focus claim.",
        ],
      },
      {
        title: "Correction numbers",
        lines: [
          "Recovery after correction is how much endorsement drops after the correction round.",
          "Time to majority adoption is the first round where endorsement goes above half.",
        ],
      },
    ],
  },
  {
    id: "outputs",
    label: "What gets saved",
    short: "files and traces",
    summary: [
      "Each run saves a short summary and a full trace.",
    ],
    sections: [
      {
        title: "Per run outputs",
        visualLines: [
          "summary.json  = quick result",
          "trace.db      = full evidence trail",
        ],
        lines: [
          "Each run writes a trace database and a summary file in output/<run id>/.",
          "The database stores events, memory writes, retrieval traces, agent claim states, metrics, and chat messages.",
        ],
      },
      {
        title: "Why both matter",
        lines: [
          "summary.json is the short result you compare quickly.",
          "trace.db is the full evidence for debugging, plotting, and later analysis.",
        ],
      },
    ],
  },
  {
    id: "screens",
    label: "How to use the interface",
    short: "reading the CLI",
    summary: [
      "The interface has launch, compare, inspect, and explain layers.",
    ],
    sections: [
      {
        title: "Main menu",
        visualLines: [
          "Run -> launch",
          "Lab -> build study groups",
          "Compare/Batch -> evaluate conditions",
        ],
        lines: [
          "Run starts one experiment.",
          "Lab is for building and launching experiment groups.",
          "Memory lets you inspect stored memory entries from past runs.",
          "Compare and Batch are the main places to do condition level evaluation.",
        ],
      },
      {
        title: "During a run",
        lines: [
          "The square shows the current agent society state on the focus claim.",
          "The metric panel shows the current run state, not a final average.",
          "The trend sparkline is the endorsement history over the run so far.",
        ],
      },
    ],
  },
];
