import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Circle
import matplotlib.font_manager as fm

# 设置中文字体
plt.rcParams['font.sans-serif'] = ['SimHei', 'Arial Unicode MS', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

# 数据
sins = {
 '傲慢': 2,
 '嫉妒': 4,
 '暴怒': 3,
 '懒惰': 6,
 '贪婪': 1,
 '暴食': 2,
 '色欲': 7
}

virtues = {
 '谦卑': 8,
 '慷慨': 9,
 '温柔': 8,
 '耐心': 7,
 '节制': 5,
 '勤奋': 8,
 '纯洁': 6
}

# 合并数据
labels = list(sins.keys()) + list(virtues.keys())
values = list(sins.values()) + list(virtues.values())

# 角度计算
num_vars = len(labels)
angles = np.linspace(0, 2 * np.pi, num_vars, endpoint=False).tolist()
values += values[:1]
angles += angles[:1]

# 创建图形
fig, ax = plt.subplots(figsize=(12, 12), subplot_kw=dict(projection='polar'))
ax.set_theta_offset(np.pi / 2)
ax.set_theta_direction(-1)

# 绘制雷达图
ax.plot(angles, values, 'o-', linewidth=2, color='#3C5A78')
ax.fill(angles, values, alpha=0.15, color='#3C5A78')

# 设置刻度
ax.set_ylim(0, 10)
ax.set_yticks(range(0, 11, 2))
ax.set_yticklabels([str(i) for i in range(0, 11, 2)], fontsize=10, color='#6B7077')

# 设置标签
ax.set_xticks(angles[:-1])
ax.set_xticklabels(labels, fontsize=12, color='#1E2227')

# 添加分数标注
for angle, value, label in zip(angles[:-1], values[:-1], labels):
 ax.text(angle, value + 0.5, str(value), 
 ha='center', va='center', fontsize=10, 
 color='#3C5A78', fontweight='bold')

# 添加分界线（七宗罪 vs 七美德）
mid_angle = angles[7]
ax.plot([mid_angle, mid_angle], [0, 10], 'r--', linewidth=1.5, alpha=0.3)

# 去除边框
ax.spines['polar'].set_visible(False)

# 设置网格
ax.grid(True, linestyle='--', alpha=0.3, color='#E7E3DA')

plt.tight_layout()
plt.savefig('七宗罪与七美德.png', dpi=300, bbox_inches='tight', facecolor='#F7F5F1')
plt.show()