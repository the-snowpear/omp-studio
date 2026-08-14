# ADR-004: System Runtime Is Classified by Capability

## Decision

System/Custom OMP 通过 Studio Hello、Capability Manifest、Command Manifest 和 smoke probe 分类为 Compatible、Limited 或 Rejected。

## Consequences

- “Compatible”不依赖安装来源或版本字符串；
- 普通当前上游 OMP 默认是 Limited；
- 上游合并 Studio Protocol 后，通用安装可以自然成为 Compatible；
- 用户选择 System 不能绕过能力和安全检查。

