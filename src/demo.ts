import { Service } from "./service";

/** 可重建演示数据：一直跳转、交替结果、两地址有意混叠。 */
export function seedDemo(svc: Service): Record<string, number> {
  // 1) 一直跳转：展示计数器从 1 饱和升到 3，包含“预测正确但计数器仍训练”的步骤
  //    （计数器 2 预测跳转且实际跳转，仍训练到 3）。
  const alwaysTaken = svc.createTrace("always-taken",
    Array.from({ length: 6 }, () => ({ address: "0x00001000", taken: true })));

  // 2) 交替结果：二位计数器在强交替序列上的表现。
  const alternating = svc.createTrace("alternating",
    Array.from({ length: 8 }, (_, i) => ({ address: "0x00002000", taken: i % 2 === 0 })));

  // 3) 有意混叠：k=4 时 0x1000>>2 与 0x1040>>2 的低 4 位相同，两个地址共享表项。
  //    前两条均为不跳转，历史保持 0，两条记录访问同一索引 0，直观展示混叠。
  const aliasing = svc.createTrace("aliasing", [
    { address: "0x00001000", taken: false },
    { address: "0x00001040", taken: false },
    { address: "0x00001000", taken: true },
    { address: "0x00001040", taken: false },
    { address: "0x00001000", taken: true },
    { address: "0x00001040", taken: false },
  ]);

  return { alwaysTaken, alternating, aliasing };
}
