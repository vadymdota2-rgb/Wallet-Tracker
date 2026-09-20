const _={account_desc:"您跟踪的钱包及其当前持仓。",account_title:"👤 我的账户",add_wallet_addr_ok:`✅ 地址已接受。

请为该钱包命名 — 最多 32 个字符（如 “Binance”）：`,add_wallet_address_label:"地址：",add_wallet_invalid:`❌ 钱包地址无效。

须以 0x 开头且为 42 个字符。请输入有效地址或点取消。`,add_wallet_name_label:"名称：",add_wallet_success:"✅ 钱包已添加",add_wallet_title:`➕ 添加钱包

发送要跟踪的钱包地址 — 格式 0x...，42 个字符。

💡 不确定添加谁？
🏆 顶级交易者 按近 30 天收益排名 — 选一个一键跟踪。
或从浏览器/分析服务粘贴地址。`,add_wallet_tracking_enabled:"已开启跟踪。",ai_acc:"模型准确率",ai_auc_hint:"0.50 等于抛硬币，1.00 等于毫无差错",ai_avoid:"回避",ai_btn:"🧠 Cortex",ai_buy:"买入",ai_collecting:"正在收集结果",ai_conf:"把握",ai_contract:"合约",ai_empty:"该时段独立钱包不足。",ai_entry:"📍 入场",ai_expire:"⏳ 有效",ai_expired:"⌛ 已过期",ai_ft_accel:"资金流加速",ai_ft_both:"两个市场都有",ai_ft_breadth:"市场广度",ai_ft_btc24:"一天的比特币",ai_ft_btcvol:"比特币波动率",ai_ft_fibback:"回调的深度",ai_ft_fibext:"当前这段走势的长度",ai_ft_fiblevel:"接近斐波那契位",ai_ft_fromlow:"距周内低点",ai_ft_fund:"资金费率",ai_ft_fundz:"资金费率对比自身一周",ai_ft_hour:"一天中的小时",ai_ft_liqoi:"爆仓与持仓量之比",ai_ft_oivlm:"持仓量与成交额之比",ai_ft_ret1:"一小时涨跌",ai_ft_ret24:"一天涨跌",ai_ft_ret6:"六小时涨跌",ai_ft_ticket:"平均单笔规模",ai_ft_tohigh:"距周内高点",ai_ft_trades:"成交笔数",ai_ft_trend:"相对均线的趋势",ai_ft_vlm24:"一天成交额",ai_ft_vol24:"一天波动率",ai_ft_voljump:"波动率跳升",ai_ft_wavegrow:"这一浪比上一浪长",ai_ft_waverun:"同向连续了几浪",ai_ft_wavewith:"顺浪还是逆浪",ai_gate_auc:"区分上涨与下跌：{v} — 需要 {need} 以上",ai_gate_else:"在所有条件齐备之前，信号由公式算出。",ai_gate_loss:"估计误差：{v} — 需低于 {need}",ai_gate_pass:"在新数据上确认 {need} 次中的 {n} 次",ai_gate_title:"启用还需要什么",ai_gate_wf:"在不同时期都站得住：{v} — 需要 {need} 以上",ai_gate_wf_min:"最弱的一段 {v} — 需要 {need} 以上",ai_gate_wf_none:"跨时期检验：满 {need} 个结果后开始，现在 {n} 个",ai_hint:`Cortex 是一个神谕：一个训练过的模型，估计价格跟随你关注的钱包的概率。当许多独立钱包朝同一方向移动时，它给出一个数字。

它看的不只是资金流：47 个特征 — 成交量与钱包数、1 小时/6 小时/一天的涨跌、波动率及其骤升、ATR、RSI、趋势、MACD、资金费率、未平仓量、爆仓、杠杆、流动性、比特币的状态和市场广度。

事件它从自己的数据里读：这枚币上币多久了、成交量比自己一周的常态高出多少、最近几小时价格被震得多厉害。上币、被黑、消息，都会在数字里留下痕迹 — 这个痕迹它学得会。新闻的文字它不读：它的历史里没有，那里也就没有可学的。

走势的形状它自己划分：把行情切成一段一段，数的是这些段的长度 — 回调有多深、是否落在斐波那契位上，新的一段是否比上一段长，同一方向连着走了几段。像分析师那样数浪，机器做不到：两个人画出来就不一样。它数的是那张图里属于算术的那部分。

模型自己决定：周期是六小时还是一天、止损与目标，以及值得冒险的仓位占比。

在没见过的数据上赢不了抛硬币之前，它不会被采用：那时由公式工作，模型状态页会这样写。这是估计，不是投资建议。`,ai_hist_avg:"平均波动：",ai_hist_btn:"📜 历史",ai_hist_empty:"暂无已完成信号。",ai_hist_head:"{b} 个信号中有 {a} 个到达目标",ai_hist_hours:"小时前",ai_hist_none:"都没有",ai_hist_open:"{n} 个信号进行中 — 首个结果还需 {h}",ai_hist_plans:"已结束计划：",ai_hist_rate:"命中率：",ai_hist_rest:"其余的触发止损或哪儿也没去",ai_hist_sl:"止损",ai_hist_title:"信号历史",ai_hist_tp:"达标",ai_hits_of:"100 次里对 {n} 次",ai_hours:"{n}小时",ai_like_coin:"目前不比抛硬币更准",ai_long:"做多",ai_loss_hint:"旁边是不用模型时的同一误差：越小越准",ai_lv_formula:"价位来自波动率",ai_lv_model:"价位由模型给出",ai_market:"市价入场",ai_mode_formula:"公式 · 模型仍在学习",ai_mode_model:"模型",ai_model_ok:"模型已启用",ai_none_now:"目前没有币种通过筛选",ai_not_passed:"模型尚未采用",ai_p_dn:"{h}内下跌概率",ai_p_short:"上涨概率",ai_p_short_dn:"下跌概率",ai_p_up:"{h}内上涨概率",ai_pass_hint:"一次通过可能是碰巧：我们会在之后的数据上再验一遍",ai_perp:"合约",ai_plan:"交易计划",ai_price_now:"当前价格",ai_risk:"风险",ai_sell:"卖出",ai_short:"做空",ai_since_signal:"自信号发出以来",ai_spot:"现货",ai_st_acc:"准确率：",ai_st_base:"基准",ai_st_btn:"🧠 模型",ai_st_cal:"校准：",ai_st_coin:"抛硬币",ai_st_gate:"门槛",ai_st_loss:"估计误差",ai_st_quality:"模型质量",ai_st_ready:"已完成结果：",ai_st_samples:"样本",ai_st_title:"模型状态",ai_st_top:"主要权重：",ai_st_trees:"棵树",ai_st_untrained:"尚未训练 — 使用公式。",ai_st_wf:"在不同时期都站得住",ai_stop:"🛑 止损",ai_take:"🎯 目标",ai_take_one:"🎯 目标",ai_title:"Cortex",ai_trade_hint:"Cortex 的估计，不是投资建议。",ai_w1h:"1时",ai_w24:"24小时",ai_w30:"30天",ai_w6h:"6时",ai_w7:"7天",ai_wait_bot:"机器人尚未发来信号",ai_wf_hint:"同样的检验，连续在几段时间上做",ai_why:"原因",ai_why_age:"上币多久",ai_why_breadth:"许多钱包",ai_why_flow:"净流向",ai_why_formula:"公式匹配到的条件",ai_why_lev:"杠杆",ai_why_liq:"池流动性",ai_why_liqskew:"清算偏斜",ai_why_oi:"未平仓",ai_why_rsi:"RSI",ai_why_share:"不是单鲸",ai_why_shock:"价格冲击",ai_why_top:"流向中的前100",ai_why_topdir:"头部方向",ai_why_vol:"成交量",ai_why_volz:"成交量骤增",alert_add_liquidity:"添加流动性",alert_amount:"金额",alert_arbitrage:"套利",alert_avg_entry:"平均成本",alert_bridge_in:"跨链转入",alert_bridge_out:"跨链转出",alert_buy:"买入",alert_buy_price:"买入价",alert_collect_fees:"收取手续费",alert_contract:"合约",alert_prior_ago:"前",alert_prior_buy:"上次买入",alert_qty:"数量",alert_received:"收入",alert_remove_liquidity:"移除流动性",alert_sell:"卖出",alert_sell_price:"卖出价",alert_spent:"支出",alert_token:"代币",alert_trade_pnl:"交易盈亏",alert_transaction:"交易",alert_transfer:"转账",alert_unwrap:"UNWRAP",alert_wallet:"钱包",alert_wrap:"WRAP",already_tracking:"⚠️ 您已在跟踪该钱包。",already_tracking_retry:`⚠️ 您已在跟踪该钱包。

请输入其他地址或点取消。`,back_button:"← 返回",big_btn_liq:"💀 最大清算",big_btn_perp:"🔵 最大持仓",big_btn_spot:"🟡 最大买入 / 卖出",big_empty:"该时段暂无交易。",big_liq_account_was:"账户余额",big_liq_closed_at:"平仓价",big_liq_loss:"亏损",big_liq_position:"仓位",big_liq_title:"最大清算 · Hyperliquid",big_menu_hint:"被追踪钱包的最大单笔交易。选择市场：",big_perp_title:"最大持仓",big_spot_title:"最大买入 / 卖出",big_title:"分析",big_track_btn:"追踪",big_win_1h:"1时",big_win_24h:"24时",big_win_30d:"30天",big_win_7d:"7天",calc_amount:"自有资金",calc_lev:"杠杆",calc_longs_earn:"多头收到",calc_note:"仅资金费 — 未计价格波动",calc_per_pay:"每次结算",calc_shorts_earn:"空头收到",calc_size:"仓位规模",cancel_button:"❌ 取消",err_invalid_address:"❌ 钱包地址无效。",err_invalid_number:"❌ 数字无效。",err_invoice_failed:"❌ 无法创建账单。请稍后再试。",err_loading_wallet:"❌ 加载钱包出错。",err_loading_wallets:"❌ 加载钱包列表出错。",err_name_empty:`❌ 名称不能为空。

请输入名称或点取消。`,err_name_too_long:`❌ 名称过长（最多 32 个字符）。

请缩短或点取消。`,err_threshold_decimals:"❌ 最多 2 位小数（如 7500.50）。",err_threshold_positive:"❌ 阈值必须为正数。",err_threshold_too_large:"❌ 阈值过高。",err_threshold_too_small:"❌ 最低提醒阈值为 $50。请输入 $50 或更高。",err_user_limit:"⚠️ 已达用户上限。请稍后再试。",err_wallet_not_found:"❌ 列表中找不到该钱包。",flow_bought:"买入",flow_btn:"🔥 巨鲸在买什么",flow_buys:"买入",flow_coins:"币种",flow_empty:"该时段暂无数据。",flow_hint:"净流入：买入减卖出",flow_in_coins:"净流入",flow_now:"现在",flow_out_coins:"净流出",flow_search_btn:"🔍 查找币种",flow_search_none:"该时段未找到。",flow_search_prompt:"发送代号 — 例如 PEPE",flow_sells:"卖出",flow_side_all:"全部",flow_side_in:"净流入",flow_side_out:"净流出",flow_sold:"卖出",flow_title:"巨鲸在买什么",flow_total_buys:"买入",flow_total_sells:"卖出",flow_trend:"市场趋势",flow_trend_hint:"该时段全部币种的累计净流入",flow_wallets:"钱包",free_plan_1_wallet:"⚠️ 免费版仅 1 个钱包。高级版 — 菜单中点 ⭐ 高级版。",fund_apr:"年化：",fund_btn:"💢 资金费失衡",fund_daily:"每天",fund_empty:"当前没有明显异常。",fund_every:"每 {h} 小时",fund_hint:"当前一方向另一方支付最多的地方",fund_hourly:"每小时",fund_in:"{t}后",fund_loading:"正在加载数据，请稍后再打开。",fund_longs_pay:"多头支付",fund_min_ago:"分钟前",fund_oi:"持仓",fund_shorts_pay:"空头支付",fund_title:"资金费失衡",fund_updated:"更新于",fund_vol:"成交额",generic_error_retry:"❌ 出错了，请重试。",help_channel:"📢 频道：t.me/WalletTrackerOfficial",help_commands:"使用菜单按钮：",help_disclaimer:`⚠️ 免责声明
机器人展示已发生的链上交易。仅为信息服务，不构成投资建议或交易推荐。过往表现不代表未来。杠杆交易可能导致本金全部损失。决策与风险由您自行承担。`,help_footer:"使用主菜单快速访问全部功能。",help_intro:"🏆 查看大户买卖 — BSC 现货兑换与 Hyperliquid 永续合约。",help_menu_add:"➕ 添加钱包 — 跟踪新钱包",help_menu_languages:"🌐 语言 — 切换语言",help_menu_mywallets:"👤 我的账户 — 查看与管理钱包",help_menu_positions:"📈 未平仓位 — Hyperliquid 持仓",help_menu_premium:"⭐ 高级版 — 查看套餐",help_menu_threshold:"💰 提醒阈值 — 设置最低金额",help_menu_top:"🏆 顶级交易者 — 30 天排名，现货与合约",help_premium_1:"• Hyperliquid 合约：排名、提醒，以及含杠杆、保证金、强平价的未平仓位",help_premium_2:"• 跟踪最多 50 个钱包（免费版 1 个）",help_premium_3:"• 完整 BSC 现货 Top 100（Top 30 免费）",help_premium_4:"• 优先推送提醒",help_premium_title:"⭐ 高级版",help_support:"📞 支持：@WalletTrackerHelp",help_title:"❓ 帮助",hl_account:"账户余额",hl_add_long:"加多",hl_add_short:"加空",hl_close_long:"平多",hl_close_short:"平空",hl_collateral:"保证金",hl_cross:"全仓",hl_entry_price:"开仓",hl_fills_in_series:"本系列成交笔数",hl_flip:"反转仓位",hl_in_position:"在仓位",hl_isolated:"逐仓",hl_leverage:"杠杆",hl_liq:"强平价",hl_liq_long:"多单强平",hl_liq_short:"空单强平",hl_liquidated:"已强平",hl_locked_body:`永续合约需开通高级版。

每笔交易可看杠杆、保证金与强平价，交易所已实现盈亏，钱包未平仓位，以及 30 天交易者排名。`,hl_mark_price:"现价",hl_no_open_positions:"该钱包当前没有未平仓位。",hl_of_account:"占账户",hl_open_long:"开多",hl_open_positions:"Hyperliquid 未平仓位",hl_open_short:"开空",hl_partial_long:"部分平多",hl_partial_short:"部分平空",hl_pnl:"已实现盈亏",hl_position_closed:"仓位已全部平仓",hl_position_left:"仓位剩余",hl_position_size:"仓位规模",hl_positions_choose:"选择钱包查看未平仓位：",hl_price:"价格",hl_qty:"数量",hl_rk_choose:"选择排名：",hl_rk_empty:"暂无数据 — 排名需每钱包 30 天内至少 5 笔已平仓交易。",hl_rk_leverage:"平均杠杆",hl_rk_roi_account:"相对本金 ROI",hl_side_long:"多",hl_side_short:"空",hl_trade:"永续成交",hl_trade_size:"成交规模",hl_unrealized:"未实现盈亏",hl_venue:"网络",hl_venue_choose:"选择网络 — BSC 现货或 Hyperliquid 永续",hl_venue_perp:"🔵 Hyperliquid — 合约",hl_venue_spot:"🟡 BSC — 现货",hl_venue_title:"顶级交易者",invoice_description:"30 天高级版订阅",invoice_price_label:"高级版（30 天）",invoice_title:"Wallet Tracker 高级版",invoice_unknown_product:"未知商品。请重试。",lang_choose:"选择提醒和菜单语言：",lang_current:"当前语言：",lang_title:"🌐 语言",legal_btn_forget:"🗑 删除我的数据",legal_btn_privacy:"🔒 隐私",legal_btn_terms:"📄 条款",legal_forget_done:"✅ 已完成。我们持有的关于你的一切都已删除。若想回来，发送 /start 即可。",legal_forget_failed:"❌ 数据删除失败，请稍后重试。",legal_forget_title:"🗑 删除我的数据",legal_forget_warn:"将抹去你跟踪的钱包、提醒门槛、语言、投递记录和支付记录。 高级版连同已付费的天数一并失去，且不退款。 此操作无法撤销。 只保留“免费一周已发放”的记录——否则它可以被再次领取。",legal_forget_yes:"是的，全部删除",legal_privacy_body:`我们只保存你的 Telegram 会话 ID、界面语言、提醒阈值，以及你要求跟踪的公开区块链地址。我们从不索要也不保存私钥、助记词、姓名、邮箱和电话；机器人既无法转走也无法卖出你的资产。

钱包的活动来自公开的区块链与交易所数据，它们独立于机器人存在，我们不会把它们与你的身份关联。Cortex 模型正是用这些公开成交和行情序列学习的；谁要求跟踪某个地址，从不进入训练。

数据存放在我们的服务器，从不出售，并且只送往为了送达消息（Telegram）和取得价格（公开接口）所必需的地方。账号存在期间我们保留；模型的结果日志保存 90 天后自行清除。

星星支付会留下一条付款记录：它在 Telegram 的编号、金额和币种。USD₮ 支付会留下账单备注、金额和转账哈希——发送方地址我们不保存。连接钱包时，它的公开地址会到我们这里，再到网络的公开浏览器：否则无法找到你的 USD₮ 钱包。它不会写入数据库。转账本身在钱包内签名，私钥和助记词从不到达我们，连接可在钱包中断开。

/forgetme 命令和「删除我的数据」按钮会立即、不可撤销地抹掉我们关于你的一切。只有一行留下：会话 ID 和发放免费一周的日期——没有它，同一个账号可以反复领取那一周。你可以通过机器人询问我们掌握了什么。

本政策可能变更；现行版本始终在这里和机器人中。`,legal_privacy_title:"🔒 隐私政策",legal_terms_body:`Wallet Tracker 是信息服务。它展示已经发生的、取自公开来源的交易，并给它们打分：带有入场、止损和目标价位的 Cortex 信号。

这不是投资建议，不是预测，更不是收益承诺。我们不管理你的资金，不代你执行任何操作，也无法接触你的资产：我们不是托管方、交易所或经纪商。决定是你的，风险也是。

Cortex 的分数是模型给出的概率，模型以最近数月的结果、二十四小时为期训练，而不是预言。准确率、AUC 和命中历史是在模型训练时没见过的数据上测得的，描述的是过去，换一种行情可能下降。模型未训练时由公式工作，屏幕会这样写明。止损和目标由波动率算出：它们是参考，不是指令，也不保证成交。

带杠杆交易可能在你来不及平仓之前就清空本金。仓位大小和杠杆由你决定。

数据来自公开来源，可能延迟、缺失或干脆错误。服务按现状提供，不保证不间断运行。在法律允许的范围内，我们的责任以你为当前订阅期支付的金额为限。

年满 18 周岁方可使用，且仅限当地法律不禁止之处；合规由你负责。

高级版是付费订阅。星星支付经由 Telegram 并遵循其规则，星星退款同样如此。区块链上的 USD₮ 转账不可撤销：已付天数不予退还，即使你删除数据也是如此。付款按账单中的备注匹配；没有备注、金额不同或用其他币种的转账可能无法自动匹配——那就请联系机器人。

试图破坏服务、绕过限制或转售访问权限的，将被终止且不退款。

条款可能变更；现行版本始终在这里和机器人中，继续使用即表示接受。问题请通过机器人。`,legal_terms_title:"📄 使用条款",limit_50_reached:"⚠️ 已达 50 个跟踪钱包上限。",ls_hint:"开多资金占开空资金的比例",ls_in_long:"做多",ls_in_short:"做空",ls_side_long:"多头",ls_side_short:"空头",ls_title:"资金流向",menu_account:"👤 我的账户",menu_add_wallet:"➕ 添加钱包",menu_alert_threshold:"💰 提醒阈值",menu_alerts_above:"提醒阈值 — 起",menu_big_trades:"📊 分析",menu_help:"❓ 帮助",menu_languages:"🌐 语言",menu_my_wallets:"💼 我的钱包",menu_no_wallets:`您尚未跟踪任何钱包。
点击 添加钱包 开始接收提醒。`,menu_open_app:"📱 打开应用",menu_positions:"📈 未平仓位",menu_premium:"⭐ 高级版",menu_title:"🚨 Wallet Tracker",menu_top_traders:"🏆 顶级交易者",menu_tracking_prefix:"跟踪中",mw_free_notice1:"ℹ️ 免费版：仅主钱包会有提醒 (🔔)。",mw_free_notice2:"其余钱包已保存（⏸），开通高级版后重新启用。",mw_no_wallets:"暂无跟踪的钱包。",mw_tap_add:"点击 ➕ 添加钱包 开始跟踪。",mw_upgrade:"⭐ 升级高级版",op_cancelled:"❌ 操作已取消。",pay_address:"收款地址",pay_amount:"金额",pay_cancelled:"支付已取消",pay_failed:"支付未完成",pay_hour:"该账单一小时内有效",pay_manual:"或手动转账",pay_memo:"备注 — 必填",pay_no_usdt:"该钱包没有 TON 网络的 USDT",pay_note:"TON 网络上的 USDT。通常一分钟内会自动开通高级版。",pay_off:"USDT 支付暂时不可用",pay_ok:"高级版已开通",pay_sign_step:"请在钱包中确认转账",pay_stars_btn:"用 Stars 支付",pay_usdt_btn:"用 USDT 支付",pay_wait_step:"正在等待网络确认…",pay_wallet_step:"正在打开钱包…",payment_success_activated:"Wallet Tracker 高级版已激活。",payment_success_duration:"有效期 30 天。",payment_success_title:"✅ 支付成功！",payments_unavailable:"支付暂时不可用。请稍后再试。",pr_active_title:"⭐ 高级版已开通",pr_buy:"⭐ 购买 — 250 星",pr_buy_ton:"💵 购买 — 3.99 USDT",pr_days_left:"剩余天数：",pr_includes:"高级版包含：",pr_limit_free:"免费版仅可跟踪 1 个钱包。",pr_limit_title:"⚠️ 已达钱包上限",pr_limit_upgrade:"升级高级版可跟踪最多 50 个钱包。",pr_price_label:"价格：",pr_renew:"⭐ 续费 — 250 星",pr_renew_ton:"💵 续费 — 3.99 USDT",pr_service_account:"服务账户 — 永久高级版。",pr_subscription_label:"订阅： 30 天",pr_title:"⭐ Wallet Tracker 高级版",pr_unlock:"解锁 Wallet Tracker 全部能力。",pr_valid_until_inline:"订阅有效期至",premium_expired_notice:`⭐ 你的高级版已到期。变化如下：

🔔 提醒 — 仅来自主钱包
其余已保存并暂停。可在 💼 我的钱包 中选择主钱包。

🔵 Hyperliquid 合约 — 已关闭
排行、提醒和持仓均不可用。

🏆 顶级交易者 — 30 位而非 100 位

续费恢复全部：50 个钱包、合约和完整 Top-100。`,remove_confirm_notice:"您将不再收到该钱包的提醒。",remove_confirm_title:"🗑️ 删除钱包？",remove_yes:"🗑️ 是，删除",rename_current_name:"当前名称：",rename_enter_new:"请输入新名称：",rename_new_name:"新名称：",rename_success:"✅ 已重命名",rename_title:"✏️ 重命名钱包",rk_avg_hold:"平均持仓",rk_btn_most_active:"🔄 最活跃",rk_btn_top_pnl:"💵 Top 盈亏",rk_btn_top_roi:"📈 Top ROI",rk_btn_top_winrate:"🎯 Top 胜率",rk_choose_ranking:"选择排名：",rk_days:"天",rk_generating:`⏳ 正在生成排名。

请一分钟后再试。`,rk_in_top:"在榜",rk_no_completed_trades:"近 30 天尚无已完成交易。",rk_roi_per_trade:"每笔 ROI",rk_top_traders_30d:"顶级交易者（30天）",rk_track:"➕ 跟踪",rk_trades:"交易",rk_unlock_top100:"🔒 开通高级版解锁 Top 100。",rot_from:"从哪里",rot_moved:"在币种间转移",rot_pairs:"对",rot_share:"占总量",rot_to:"到哪里",threshold_choose:"选择预设或输入自定义金额：",threshold_current:"当前阈值：",threshold_custom_btn:"✏️ 自定义金额",threshold_custom_title:`💰 自定义阈值

输入最低提醒金额（美元）— 从 $50 起（如 7500 或 7500.50）：`,threshold_desc:"仅当交易达到或超过此金额时才会提醒您。",threshold_retry_hint:"请输入有效金额（如 7500 或 7500.50）或点取消。",threshold_save_failed:"❌ 无法保存阈值。请重试。",threshold_title:"💰 提醒阈值",threshold_unchanged:"ℹ️ 当前阈值已是",threshold_updated:`✅ 提醒阈值已更新

当前阈值：`,toast_already_tracking:"✅ 已在跟踪",toast_invalid_address:"❌ 地址无效。",toast_main_wallet_set:"主钱包已更新",toast_wallet_removed:"✅ 钱包已删除",ton_invoice_footer:"转账后一分钟内高级版自动开启。账单有效期 1 小时。",ton_invoice_header:`💵 USDT 支付 — 3.99

从任意 TON 钱包发送：`,ton_memo_warning:"⚠️ 没有备注就无法把这笔付款和你的账号对应起来。部分交易所提现不支持备注 — 那就从钱包发送。",ton_network_note:"仅通过 TON 网络发送 — 其他网络的币将丢失。",ton_paid_ok:`✅ 已收到付款 — 高级版已激活 30 天。

所有钱包、Hyperliquid 合约和完整 Top-100 已恢复。`,ton_scam_note:"🔒 这些信息仅在本机器人内有效。我们绝不会私聊索要付款。",ton_step_address:"地址",ton_step_amount:"金额",ton_step_memo:"备注 — 必填",ton_step_network:"网络",ton_support_note:"付款未到账？联系 @WalletTrackerHelp 并附上备注中的代码。",track_name_prompt:"🏷 请为该交易者命名：",track_now_tracked:"✅ 钱包",track_now_tracked_suffix:"正在跟踪。",trial_granted:`🎁 7 天高级版 — 赠送

您获得：Hyperliquid 合约排名、提醒与仓位，最多 50 个钱包，完整 Top 100，优先提醒。

每账户一次。`,ui_analytics_hint:"从被追踪钱包看市场：资金流向、大额交易、持仓与资金费率。",ui_buy_pressure:"买盘占比",ui_buys:"买入次数",ui_chart:"图表",ui_chg24:"24 小时涨跌",ui_cls_crypto:"加密货币",ui_cls_rwa:"股票与金属",ui_copied:"地址已复制",ui_copied_name:"名称已复制",ui_copy:"复制",ui_copy_failed:"复制失败",ui_deals:"交易记录",ui_deals_last:"最近 10 笔",ui_free_slots:"剩余名额",ui_held_since:"持有时长",ui_hip3:"股票",ui_invested:"投入",ui_legal:"条款与政策",ui_liquidated:"强平",ui_loading:"加载中",ui_locked:"高级版可用",ui_more:"更多",ui_no_quotes:"该代币没有行情数据，价位见下方数字",ui_no_signals:"该时间窗内没有信号",ui_nothing:"暂时没有内容",ui_offline:"无法连接服务器",ui_open_bot:"打开机器人",ui_partial_note:"部分买入发生在该钱包纳入跟踪之前，因此入场价和投入金额被低估。",ui_partial_tag:"不完整",ui_pay_in_bot:"付款在机器人聊天中完成 — 小程序无法开具账单。",ui_portfolio:"投资组合",ui_pulse:"巨鲸脉搏 · 24 小时",ui_retry:"重试",ui_rot_hint:"资金从哪些币流出、又流入哪些币",ui_rotation:"轮动",ui_save:"保存",ui_saved:"已保存",ui_set_main:"设为主钱包",ui_show_more:"显示更多",ui_side_buys:"买入",ui_side_sells:"卖出",ui_spot_open:"BSC 买入，仍在持有",ui_sync_failed:"刷新失败",ui_tab_funding:"资金费",ui_tab_ls:"多 / 空",ui_tab_orders:"大额订单",ui_tab_positions:"大额持仓",ui_tf_15m:"15分",ui_tf_1d:"1天",ui_tf_1h:"1小时",ui_tf_1mo:"1月",ui_tf_1w:"1周",ui_tf_4h:"4小时",ui_to_liq:"距强平",ui_updated:"已更新",ui_wallet_count:"个钱包",ui_worth_now:"当前价值",unit_day:"天",unit_hour:"时",unit_min:"分",unit_sec:"秒",unknown_command:"🤔 请使用下方菜单。",wallet_bot_banned:`🤖 这是交易机器人：每天数百笔交易，不在排行榜内。追踪没有意义。

请输入其他地址或点击取消。`,wallet_bot_removed:"🤖 该钱包已从你的列表中移除 — 这是交易机器人。每天数百笔交易且不在排行榜内，追踪没有意义。",wallet_limit_50_short:"⚠️ 钱包上限（50）",wc_free_note:"你也可以自己添加任意钱包：在 💼 我的钱包 中发送地址。",wc_how:`被追踪的钱包一旦买入、卖出或开仓，你会在约 4 秒后收到提醒。

BSC 现货与 Hyperliquid 合约。每个数字都可用交易哈希核验。`,wc_next_btn:"➡️ 进入菜单",wc_title:"🚨 Wallet Tracker",wc_top_intro:"从最佳交易者开始：",wc_track_btn:"追踪",wc_track_done:"✅ 已添加 — 你将收到该钱包的提醒",wc_tracked_btn:"追踪中",wl_main_wallet:"主",wl_not_ranked:"未入榜",wl_paused:"已暂停",wl_perp_rank:"合约",wl_spot_rank:"现货",ws_winrate:"胜率"};export{_ as zh};
