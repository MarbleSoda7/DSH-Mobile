<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH 服务器授权说明（模板）</title>
<style>
  body { font: 15px/1.8 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 40px auto; max-width: 760px; color: #222; }
  code { background: #f2f2f2; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  pre { background: #f7f7f7; border: 1px solid #e2e2e2; border-radius: 8px; padding: 14px; overflow-x: auto; font-size: 13px; }
  .warn { background: #fff4f4; border-left: 4px solid #d33; padding: 12px 16px; border-radius: 6px; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 28px; }
</style>
</head>
<body>
<h1>DSH 手机接管插件：服务器 SSH 授权说明</h1>

<div class="warn">
  <b>先说清楚风险。</b>
  这台插件的服务器地址和 SSH 密钥是公开在仓库里的，所以服务器上必须把它降成
  <b>只能做端口转发、不能执行任何命令</b>的账号。按下面的配置做完之前，
  任何人 clone 这个仓库都能拿到你服务器的 root 交互 shell。
</div>

<h2>1. 改 sshd：禁止 root 登录</h2>
<p>编辑 <code>/etc/ssh/sshd_config</code>，把</p>
<pre>PermitRootLogin yes</pre>
<p>改成</p>
<pre>PermitRootLogin prohibit-password</pre>
<p>如果你有别的账号要登录服务器，就干脆写 <code>PermitRootLogin no</code>，只用普通账号运维。改完 <code>systemctl reload sshd</code>。</p>

<h2>2. 给插件键加限制（关键）</h2>
<p>
  插件用的公钥写死带注释 <code>dsh-mobile-remote</code>。<b>每台电脑用的都是同一把</b>，
  所以它天生就是个共享秘密，必须收窄到只剩转发。把这一行加/改成：
</p>
<pre>restrict,port-forwarding,command="/usr/sbin/nologin" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBkIQtubpVlY6vggY9dixD2Cv5UMvte4x/Z+Iq3WgBxY dsh-mobile-remote</pre>
<p>
  <code>restrict</code> 会关掉 pty、agent 转发、X11 转发、端口监听的协商，<code>port-forwarding</code>
  再把转发单独放回来；<code>command=</code> 让这条键连「执行一条命令」都不行。结果就是：
  <b>能开隧道，但拿不到任何 shell，也读不了任何文件</b>。
</p>
<p>服务端还需要保留 <code>GatewayPorts clientspecified</code>，否则 <code>-R 0.0.0.0:端口</code> 起不来。</p>

<h2>3. 每台电脑发自己的密钥（根治，推荐）</h2>
<p>
  共享密钥无法吊销单台设备——你知道谁泄露都收不回来。正确做法是每台电脑自己生成一对，
  你手动把它的公钥加到服务器，并删除仓库里那把共享键：
</p>
<pre>
# 电脑上
ssh-keygen -t ed25519 -N "" -f ~/.ssh/dsh_mobile_remote_ed25519

# 服务器上（把 &lt;那台电脑的公钥&gt; 换成它 .pub 的内容）
echo 'restrict,port-forwarding,command="/usr/sbin/nologin" &lt;那台电脑的公钥&gt; dsh-mr-&lt;机器名&gt;' >> /root/.ssh/authorized_keys
</pre>
<p>这样哪台机器出了事，删掉它那一行就行，其他机器不受影响。</p>

<h2>4. 不要用 root 跑转发</h2>
<p>
  建议建一个普通账号 <code>mr-tunnel</code>，只用来开隧道；<code>authorized_keys</code> 里这条公钥
  放到那个账号下，并把插件配置里的 <code>tunnel.user</code> 改成它。
</p>

<h2>5. 转发端口同样要限</h2>
<p>
  <code>restrict</code> 管不住「转发到哪个目标端口」。能连上 127.0.0.1:7790 就等于能调用分配接口，
  能连 127.0.0.1:6379 就等于能操作 Redis。服务器上用 <code>PermitOpen</code> 把目标钉死：
</p>
<pre>restrict,port-forwarding,command="/usr/sbin/nologin",permitopen="127.0.0.1:7788",permitopen="127.0.0.1:7790" ssh-ed25519 ... dsh-mobile-remote</pre>

<h2>6. 检查清单</h2>
<pre>
# 确认拿到的是 shell 还是被拒绝
ssh -i ~/.ssh/dsh_mobile_remote_ed25519 root@你的服务器 echo hi
# 期望：/usr/sbin/nologin 或拒绝执行

# 确认只开了隧道也能用
ssh -N -R 0.0.0.0:9000:127.0.0.1:7788 root@你的服务器
</pre>
</body>
</html>
