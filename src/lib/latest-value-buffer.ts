export class LatestValueBuffer<T> {
  private readonly values = new Map<string, T>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly delayMs: number,
    private readonly commit: (values: T[]) => void,
  ) {}

  push(key: string, value: T, flush = false): void {
    this.values.set(key, value)
    if (flush) {
      this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.delayMs)
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.values.size === 0) return
    const values = [...this.values.values()]
    this.values.clear()
    this.commit(values)
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.values.clear()
  }
}
