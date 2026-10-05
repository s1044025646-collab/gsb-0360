/**
 * 可重建的演示轨迹：
 *  1. always-taken   一直跳转
 *  2. alternating    交替结果
 *  3. aliasing       两个地址有意映射同一表项（在相同历史下），
 *                    并至少包含一次“预测正确但计数器仍训练”的情况。
 */
import { BranchRecord } from './core.js';

export interface DemoTrace {
  name: string;
  k: number;
  description: string;
  branches: BranchRecord[];
}

export function demoTraces(): DemoTrace[] {
  // 1) 一直跳转：展示计数器 1→2→3 后停在 3（饱和不绕回）。
  const alwaysTaken: BranchRecord[] = Array.from({ length: 6 }, () => ({
    pc: 0x1000,
    taken: true,
  }));

  // 2) 交替结果：全局历史不断变化，同一地址在不同历史下访问不同索引。
  const alternating: BranchRecord[] = Array.from({ length: 8 }, (_, i) => ({
    pc: 0x2000,
    taken: i % 2 === 0,
  }));

  // 3) 有意混叠（k=2）：
  //   PC A=0x0000 -> PC>>2 = 0；PC B=0x0010 -> PC>>2 = 4(100)。
  //   低 2 位：0 XOR h 与 4 XOR h 在 h 相时而相等（4 的低 2 位为 00），
  //   因此两个不同地址在相同历史下落到同一表项，发生互相干扰。
  //   seq5 之后历史回到 00，seq6 让 B 在 h=00 访问索引 00，
  //   读到 seq0 时 A 训练成的“倾向跳转”计数器 -> B 实际不跳却被预测跳，
  //   直观展示混叠造成的误预测。
  //   seq2 预测不跳且实际不跳（命中），计数器仍从 1 训练到 0（命中也训练）。
  const aliasing: BranchRecord[] = [
    { pc: 0x0000, taken: true }, // seq0 h=00 idx=0(=(0^0)&3) ctr 1->2 预测N 失败 新h=01
    { pc: 0x0010, taken: true }, // seq1 h=01 idx=1(=(4^1)&3) ctr 1->2 预测N 失败 新h=11
    { pc: 0x0010, taken: false }, // seq2 h=11 idx=3 ctr 1->0 预测N 命中(仍训练) 新h=10
    { pc: 0x0000, taken: true }, // seq3 h=10 idx=2 ctr 1->2 预测N 失败 新h=01
    { pc: 0x0010, taken: false }, // seq4 h=01 idx=1 ctr 2->1 预测T 失败 新h=10
    { pc: 0x0010, taken: false }, // seq5 h=10 idx=2 ctr 2->1 预测T 失败 新h=00
    { pc: 0x0010, taken: false }, // seq6 h=00 idx=0 与seq0的A混叠：读A训练出的2 预测T 失败 新h=00
    { pc: 0x0000, taken: true }, // seq7 h=00 idx=0 同址同历史但已被B拉低 ctr 1->2 预测N 失败 新h=01
  ];

  return [
    {
      name: 'demo-always-taken',
      k: 2,
      description: '一直跳转：观察饱和计数器收敛到 3 且不绕回',
      branches: alwaysTaken,
    },
    {
      name: 'demo-alternating',
      k: 3,
      description: '交替结果：同一地址因全局历史不同而访问不同索引',
      branches: alternating,
    },
    {
      name: 'demo-aliasing',
      k: 2,
      description: '两个地址有意混叠到同一表项，并含预测正确但仍训练的步骤',
      branches: aliasing,
    },
  ];
}
