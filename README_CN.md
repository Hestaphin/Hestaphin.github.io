# PUCO 网站接入 Supabase（纯网页后台操作版，不用本地，不用 Supabase CLI）

这份更新版已经按你的新要求改好了两件事：

1. **不需要本地开发，也不需要 Supabase CLI**
2. **membership 只有支付成功之后，才会创建账号**

并且原来的页面布局没有做大改，只调整了 membership 页面里的实际流程文案和表单逻辑。

---

# 一、现在的真实流程

## 1）Internal login
这一套还是：
- 管理员 `admin@pkuco.org / 12345678` 登录
- 管理员后台可改自己密码
- 管理员可新建 internal 账号
- internal 成员首次登录后可改密码
- 管理员可给成员发文字、图片、文件
- 管理员可删除除自己外的其他 internal 账号
- 成员可登录后查看、下载管理员发来的内容
- 有 logout
- 有无操作自动 logout

## 2）Membership login（已按你要求改）
现在改成：
- 会员先输入 **邮箱 + 选择付费项目**
- 点击后直接去 Stripe 支付
- **只有 Stripe webhook 确认支付成功后**，系统才会：
  - 创建 Supabase Auth 账号
  - 创建 `profiles` 里的 member 资料
  - 写入 `membership_orders`
  - 给这个邮箱发送激活邮件
- 用户打开邮件里的激活链接
- 回到 `/membership/` 页面设置密码
- 然后再进入 membership portal

也就是说：**没付款，不建账号。**

---

# 二、你需要在 Supabase 后台做的事

## 第 1 步：创建 Supabase 项目
进入 Supabase 后台：
- New project
- 建一个项目，例如 `puco-site`
- 记住数据库密码

项目建好后，去：
- **Project Settings → API**

记下这两个值：
- Project URL
- anon public key

然后打开代码里的：
- `site/config.js`

把里面的占位内容改成你自己的：

```js
window.PUCO_SUPABASE_URL = '你的 Project URL';
window.PUCO_SUPABASE_ANON_KEY = '你的 anon key';
```

---

## 第 2 步：运行数据库 SQL
进入：
- **SQL Editor**

把下面这个文件里的全部内容复制进去执行：
- `site/supabase/schema.sql`

这个 SQL 会创建：
- `profiles`
- `membership_plans`
- `membership_checkout_requests`
- `membership_orders`
- `internal_messages`
- `internal_message_recipients`
- `internal-files` storage bucket
- RLS 策略

---

## 第 3 步：手动创建初始管理员
进入：
- **Authentication → Users → Add user**

手动创建：
- email: `admin@pkuco.org`
- password: `12345678`
- 邮箱确认设为已确认

创建后，复制这个用户的 UUID。

然后回到 **SQL Editor** 执行：

```sql
insert into public.profiles (user_id, email, full_name, role)
values (
  '这里换成管理员UUID',
  'admin@pkuco.org',
  'PUCO Administrator',
  'admin'
)
on conflict (user_id) do update
set role = 'admin',
    email = excluded.email,
    full_name = excluded.full_name;
```

这样管理员就真正可用了。

---

# 三、Stripe 要怎么接

## 第 4 步：在 Stripe 建会员价格
你需要在 Stripe 后台创建 3 个价格：
- Membership Standard
- Membership Supporter
- Membership Patron

每一个都会得到一个 `price_xxx`。

然后回到 Supabase 的 SQL Editor，把数据库里的价格 id 更新掉：

```sql
update public.membership_plans
set stripe_price_id = 'price_xxx'
where slug = 'Membership Standard';

update public.membership_plans
set stripe_price_id = 'price_xxx'
where slug = 'Membership Supporter';

update public.membership_plans
set stripe_price_id = 'price_xxx'
where slug = 'Membership Patron';
```

---

# 四、不用 CLI，直接在 Supabase 后台创建 Edge Functions

你说了不要本地，也不要 Supabase CLI，所以这次全部改成 **后台手动创建**。

进入：
- **Edge Functions**

你需要创建 4 个函数，名字要和代码目录一致：
- `create-internal-user`
- `delete-internal-user`
- `create-checkout-session`
- `stripe-webhook`

做法是：
1. 在 Supabase Dashboard 里点 **Create function**
2. 名字输入上面对应名字
3. 把压缩包中对应文件的代码复制进去

对应关系：
- `site/supabase/functions/create-internal-user/index.ts`
- `site/supabase/functions/delete-internal-user/index.ts`
- `site/supabase/functions/create-checkout-session/index.ts`
- `site/supabase/functions/stripe-webhook/index.ts`

保存并部署。

---

# 五、在后台设置函数 Secrets

进入：
- **Project Settings → Edge Functions → Secrets**

至少加下面这些：

```txt
STRIPE_SECRET_KEY=你的 Stripe secret key
STRIPE_WEBHOOK_SIGNING_SECRET=你的 Stripe webhook signing secret
SITE_URL=https://你的网站域名
```

例如：

```txt
SITE_URL=https://pkuco.org
```

如果你现在还是先在 GitHub Pages 上测试，就填测试域名。

---

# 六、Stripe webhook 怎么填

进入 Stripe 后台，创建 webhook endpoint。

地址填：

```txt
https://你的-project-ref.supabase.co/functions/v1/stripe-webhook
```

监听事件至少加这两个：
- `checkout.session.completed`
- `checkout.session.expired`

然后 Stripe 会给你一个 webhook signing secret，把它填进刚才的：
- `STRIPE_WEBHOOK_SIGNING_SECRET`

---

# 七、现在 membership 页面到底怎么工作

## 前端逻辑
现在 `/membership/` 页面已经改成：

### Step 1
输入：
- 邮箱
- 会员档位

点击后会调用：
- `create-checkout-session`

这个函数会：
1. 在 `membership_checkout_requests` 先记录一条待支付请求
2. 创建 Stripe Checkout Session
3. 跳转到 Stripe 托管支付页

### Step 2
支付成功后，用户会回到 `/membership/?checkout=success`

这时页面会提示：
- 支付已收到
- 请去邮箱打开激活邮件
- 回到当前页面设置密码

### 后台 webhook
真正完成“建账号”的不是前端，而是 `stripe-webhook`：

它收到 `checkout.session.completed` 后，会：
1. 找到 `membership_checkout_requests`
2. 检查这个邮箱有没有现成账号
3. 如果没有，就**这时才创建账号**，并发送激活邮件
4. 创建 / 更新 `profiles`
5. 写入 `membership_orders`
6. 把会员状态设为 `active`

所以这版逻辑完全符合你的要求：

**支付成功之前，没有会员账号。**

---

# 八、你部署静态网页时要上传哪些文件

把 `site/` 整个目录部署到你的网站空间即可。

关键文件是：
- `index.html`
- `app.js`
- `style.css`
- `config.js`
- 各页面目录

如果你是 GitHub Pages，也还是一样上传网页文件；只是 Supabase 和 Stripe 在云端工作，不需要你本地跑项目。

---

# 九、这次和上一版相比，改了什么

这次重点改动是：

## 1. 去掉“先注册账号再付款”
旧版是：
- 先邮箱验证
- 先创建账号
- 再付款

新版是：
- 先付款
- **付款成功后再建账号**

## 2. 去掉“必须 CLI 部署”的说明
旧版说明里有：
- `supabase login`
- `supabase link`
- CLI deploy

这次已经改成：
- 直接在 Supabase Dashboard 里手动创建函数
- 手动粘贴代码
- 手动部署

---

# 十、你现在最先要做的顺序

你可以完全按下面顺序来：

1. 创建 Supabase 项目
2. 在 `site/config.js` 填 URL 和 anon key
3. 跑 `site/supabase/schema.sql`
4. 手动创建管理员 `admin@pkuco.org`
5. 给管理员写入 `profiles` 的 admin 角色
6. 在 Stripe 建 3 个 price
7. 把 `price_xxx` 写回数据库
8. 在 Supabase 后台创建 4 个 Edge Functions
9. 配置 Edge Function secrets
10. 在 Stripe 配 webhook 到 `stripe-webhook`
11. 部署整个 `site/` 到你的网站
12. 测试 internal 登录
13. 测试 membership 付款 → 收邮件 → 设密码 → 登录

---

# 十一、这份压缩包里你重点看哪里

最关键的是这几个文件：

- `site/app.js`
- `site/membership/index.html`
- `site/supabase/schema.sql`
- `site/supabase/functions/create-checkout-session/index.ts`
- `site/supabase/functions/stripe-webhook/index.ts`

这几个文件就是这次“付款成功后才建会员账号”的核心。
