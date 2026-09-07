"""Generate appendix figures for the ICLR paper."""
import matplotlib.pyplot as plt
import matplotlib
import numpy as np

matplotlib.rcParams['font.family'] = 'sans-serif'
matplotlib.rcParams['font.size'] = 11

# ============================================================
# Figure A: Ambiguity gradient (horizontal bar chart)
# ============================================================
fig1, ax1 = plt.subplots(figsize=(8, 5))

topics = [
    'SciTaT', 'Ego depletion', 'PANDAS', 'LK-99',
    'STAP cells', 'Climate/CO₂', 'MMR/vaccines',
    'GSM-Hard (Llama)', 'GSM-Hard (Haiku)', 'GSM8K'
]
contagion = [100, 100, 60, 60, 40, 20, 0, 60, 0, 0]
colors = ['#d62728' if c >= 80 else '#ff7f0e' if c >= 40 else '#2ca02c' for c in contagion]

y_pos = np.arange(len(topics))
bars = ax1.barh(y_pos, contagion, color=colors, edgecolor='white', height=0.7)

ax1.set_yticks(y_pos)
ax1.set_yticklabels(topics)
ax1.set_xlabel('Contagion rate (%)')
ax1.set_xlim(0, 105)
ax1.set_title('Contagion by topic (shared record, 4/6 liars, Claude Haiku)')
ax1.axvline(x=50, color='gray', linestyle='--', alpha=0.3)

for i, (bar, val) in enumerate(zip(bars, contagion)):
    ax1.text(val + 2, i, f'{val}%', va='center', fontsize=10)

# Add category annotations
ax1.text(95, 9.5, 'Computable', fontsize=8, color='gray', ha='right')
ax1.text(95, 6.8, 'Familiar science', fontsize=8, color='gray', ha='right')
ax1.text(95, 0.2, 'Screened\n(no-context acc ≤0.35)', fontsize=8, color='gray', ha='right')

ax1.invert_yaxis()
plt.tight_layout()
fig1.savefig('paper/fig/fig_gradient.png', dpi=300, bbox_inches='tight')
print("Saved fig_gradient.png")

# ============================================================
# Figure B: Cross-model comparison (grouped bar chart)
# ============================================================
fig2, ax2 = plt.subplots(figsize=(9, 5))

models = ['Gemma\n4B', 'Llama\n8B', 'Mistral\n8B', 'Haiku', 'Sonnet', 'Opus', 'GPT-4o\nmini']
memory_fe = [0.930, 0.870, 0.830, 0.750, 0.730, 0.760, 0.750]
debate_fe = [None, 0.470, 0.500, 0.000, 0.230, 0.470, 0.500]

x = np.arange(len(models))
width = 0.35

bars_mem = ax2.bar(x - width/2, memory_fe, width, label='Shared record', color='#d62728', alpha=0.85)

debate_vals = [v if v is not None else 0 for v in debate_fe]
debate_colors = ['#2ca02c' if v is not None else '#cccccc' for v in debate_fe]
bars_deb = ax2.bar(x + width/2, debate_vals, width, label='Live debate', color=debate_colors, alpha=0.85)

ax2.axhline(y=0.667, color='gray', linestyle='--', alpha=0.5, label='FE floor (4/6 liars)')
ax2.set_ylabel('False Endorsement (FE)')
ax2.set_xlabel('Model')
ax2.set_title('All 7 models fall in shared records. Debate protection varies.')
ax2.set_xticks(x)
ax2.set_xticklabels(models)
ax2.set_ylim(0, 1.0)
ax2.legend(loc='upper right')

for i, v in enumerate(memory_fe):
    ax2.text(i - width/2, v + 0.02, f'{v:.2f}', ha='center', fontsize=8)
for i, v in enumerate(debate_fe):
    if v is not None:
        ax2.text(i + width/2, v + 0.02, f'{v:.2f}', ha='center', fontsize=8)
    else:
        ax2.text(i + width/2, 0.02, 'n/a', ha='center', fontsize=8, color='gray')

plt.tight_layout()
fig2.savefig('paper/fig/fig_crossmodel.png', dpi=300, bbox_inches='tight')
print("Saved fig_crossmodel.png")

# ============================================================
# Figure C: Specialist confidence trajectory over 18 steps
# ============================================================
fig3, ax3 = plt.subplots(figsize=(8, 4.5))

steps = list(range(0, 19))

# Specialist confidence toward endorsement in shared record (drifts from 0.20 to 0.48)
spec_shared = [0.20, 0.20, 0.20, 0.20, 0.35, 0.35, 0.37, 0.38, 0.39, 0.40,
               0.41, 0.42, 0.43, 0.44, 0.45, 0.46, 0.47, 0.47, 0.48]

# Regular agent in shared record (flips at step 5, grows)
reg_shared = [0.20, 0.20, 0.20, 0.20, 0.20, 0.72, 0.72, 0.73, 0.73, 0.73,
              0.73, 0.73, 0.74, 0.74, 0.74, 0.75, 0.75, 0.75, 0.75]

# Specialist in debate (holds at reject)
spec_debate = [0.20] + [0.50]*2 + [0.72]*2 + [0.75]*2 + [0.78]*2 + [0.80]*2 + [0.82]*8

ax3.plot(steps, spec_shared, 'b--', marker='s', markersize=4, label='Specialist (shared record)', linewidth=2)
ax3.plot(steps, reg_shared, 'r-', marker='o', markersize=4, label='Regular agent (shared record)', linewidth=2)
ax3.plot(steps, spec_debate, 'b-', marker='s', markersize=4, label='Specialist (debate)', linewidth=2, alpha=0.5)

ax3.axhline(y=0.667, color='gray', linestyle=':', alpha=0.4)
ax3.text(17.5, 0.69, 'FE floor', fontsize=8, color='gray')

ax3.axvline(x=5, color='red', linestyle=':', alpha=0.3)
ax3.text(5.3, 0.25, 'Regular\nflips', fontsize=8, color='red', alpha=0.6)

ax3.set_xlabel('Step')
ax3.set_ylabel('Confidence toward endorsement')
ax3.set_title('Belief trajectory: shared record vs debate (ego depletion, seed 1)')
ax3.set_ylim(0, 0.85)
ax3.set_xlim(-0.5, 18.5)
ax3.legend(loc='center right', fontsize=9)

plt.tight_layout()
fig3.savefig('paper/fig/fig_trajectory.png', dpi=300, bbox_inches='tight')
print("Saved fig_trajectory.png")

# ============================================================
# Figure D: Mitigation hierarchy (horizontal bar chart)
# ============================================================
fig4, ax4 = plt.subplots(figsize=(9, 5.5))

defenses = [
    'No defense (baseline)',
    'Fade old entries',
    'Larger model (Opus)',
    'Force skeptic to write',
    '2-entry record limit',
    'Late correction',
    'Independence warning',
    'Early correction',
    'Skeptic writes first',
    'Star/chain topology',
    'Live debate (Haiku)',
    'Truth labels',
]
contagion_rate = [
    100,   # baseline: 5/5
    100,   # fade: 5/5
    100,   # Opus: 5/5
    100,   # force skeptic: 5/5
    80,    # 2-entry limit: 4/5
    60,    # late correction: 3/5
    None,  # independence warning: FE reduction, no contagion rate
    40,    # early correction: 2/5
    0,     # skeptic writes first: 0/5
    0,     # star/chain: 0/10
    0,     # debate: 0/30
    0,     # truth labels: 0/10
]
fe_values = [
    0.750,  # baseline
    0.733,  # fade
    0.760,  # Opus
    0.833,  # force skeptic
    0.700,  # 2-entry limit
    0.667,  # late correction
    0.700,  # independence warning
    0.667,  # early correction
    0.667,  # skeptic writes first
    0.067,  # star/chain
    0.000,  # debate
    0.667,  # truth labels (at floor)
]
tier_colors = {
    'Backfires': '#d62728',
    'Fails': '#ff7f0e',
    'Marginal': '#bcbd22',
    'Partial': '#17becf',
    'Eliminates': '#2ca02c',
    'Baseline': '#7f7f7f',
}
tiers = [
    'Baseline', 'Backfires', 'Backfires', 'Fails', 'Fails', 'Fails',
    'Marginal', 'Partial', 'Partial', 'Eliminates', 'Eliminates', 'Eliminates',
]
colors = [tier_colors[t] for t in tiers]

y_pos = np.arange(len(defenses))

# Plot contagion rate bars (use FE for independence warning since it has no contagion rate)
plot_vals = [c if c is not None else -1 for c in contagion_rate]
bars = ax4.barh(y_pos, plot_vals, color=colors, edgecolor='white', height=0.7)

# Hide the independence warning bar (we'll annotate it instead)
bars[6].set_width(0)

ax4.set_yticks(y_pos)
ax4.set_yticklabels(defenses)
ax4.set_xlabel('Contagion rate (% of seeds)')
ax4.set_xlim(-5, 115)
ax4.set_title('Mitigation hierarchy (ego depletion, 4/6 liars, Claude Haiku)')

# Baseline reference line
ax4.axvline(x=100, color='gray', linestyle='--', alpha=0.3)

# Annotate values
for i, (c, fe) in enumerate(zip(contagion_rate, fe_values)):
    if c is not None:
        ax4.text(c + 2, i, f'{c}%  (FE {fe:.3f})', va='center', fontsize=9)
    else:
        ax4.text(2, i, f'FE {fe:.3f}  (d=−0.62, p=0.08)', va='center', fontsize=9,
                 fontstyle='italic')

# Tier legend
from matplotlib.patches import Patch
legend_elements = [
    Patch(facecolor=tier_colors['Eliminates'], label='Eliminates contagion'),
    Patch(facecolor=tier_colors['Partial'], label='Partial reduction'),
    Patch(facecolor=tier_colors['Marginal'], label='Marginal effect'),
    Patch(facecolor=tier_colors['Fails'], label='Fails'),
    Patch(facecolor=tier_colors['Backfires'], label='Backfires'),
    Patch(facecolor=tier_colors['Baseline'], label='Baseline (no defense)'),
]
ax4.legend(handles=legend_elements, loc='lower right', fontsize=8, framealpha=0.9)

ax4.invert_yaxis()
plt.tight_layout()
fig4.savefig('paper/fig/fig_mitigations.png', dpi=300, bbox_inches='tight')
print("Saved fig_mitigations.png")

# ============================================================
# Figure E: Liar ratio effect (line chart)
# ============================================================
fig5, ax5 = plt.subplots(figsize=(7, 4.5))

# 6-agent groups
ratios_6 = [17, 50, 67, 83]
fe_6 = [0.167, 0.767, 0.750, 0.917]
labels_6 = ['1/6', '3/6', '4/6', '5/6']

ax5.plot(ratios_6, fe_6, 'r-o', markersize=7, linewidth=2, label='6-agent shared record')

for r, f, l in zip(ratios_6, fe_6, labels_6):
    ax5.annotate(f'{l}\nFE {f:.3f}', (r, f), textcoords='offset points',
                 xytext=(0, 12), ha='center', fontsize=8)

# Debate point
ax5.plot(83, 0.017, 'gs', markersize=9, label='5/6 liars in debate')
ax5.annotate('5/6 debate\nFE 0.017', (83, 0.017), textcoords='offset points',
             xytext=(-40, -18), ha='center', fontsize=8, color='green')

# FE floor line
ax5.axhline(y=0.667, color='gray', linestyle='--', alpha=0.5, label='FE floor (4/6 liars)')

ax5.set_xlabel('Liar ratio (%)')
ax5.set_ylabel('False Endorsement (FE)')
ax5.set_title('Contagion by liar ratio (ego depletion, Claude Haiku)')
ax5.set_xlim(10, 90)
ax5.set_ylim(-0.05, 1.05)
ax5.legend(loc='center left', fontsize=9)

plt.tight_layout()
fig5.savefig('paper/fig/fig_ratio.png', dpi=300, bbox_inches='tight')
print("Saved fig_ratio.png")

# ============================================================
# Figure F: Exit timing (bar chart)
# ============================================================
fig6, ax6 = plt.subplots(figsize=(7, 4))

exit_labels = ['1 round\n(step 1)', '3 rounds\n(step 3)', '6 rounds\n(step 6)',
               '12 rounds\n(step 12)', 'Never\n(step 18)']
exit_fe = [0.700, 0.733, 0.767, 0.800, 0.750]
exit_contagion = [40, 60, 100, 100, 87]

x = np.arange(len(exit_labels))
bars6 = ax6.bar(x, exit_contagion, color=['#2ca02c', '#ff7f0e', '#d62728', '#d62728', '#d62728'],
                edgecolor='white', width=0.6)

ax6.set_xticks(x)
ax6.set_xticklabels(exit_labels)
ax6.set_ylabel('Contagion rate (%)')
ax6.set_title('How long liars need to stay (ego depletion, 4/6 liars, Claude Haiku)')
ax6.set_ylim(0, 115)

for i, (c, f) in enumerate(zip(exit_contagion, exit_fe)):
    ax6.text(i, c + 3, f'{c}%\nFE {f:.3f}', ha='center', fontsize=9)

ax6.axhline(y=100, color='gray', linestyle=':', alpha=0.3)

plt.tight_layout()
fig6.savefig('paper/fig/fig_exit.png', dpi=300, bbox_inches='tight')
print("Saved fig_exit.png")

plt.close('all')
print("\nAll 6 figures saved to iclr2027/fig/")
