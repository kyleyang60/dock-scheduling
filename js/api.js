/**
 * 碼頭排程系統 - 後端功能（取代 Code.gs）
 *
 * 每個函式名稱與原本 Apps Script 的功能名稱相同，回傳格式也相同，
 * 所以頁面裡的 authRun().withSuccessHandler(...).功能名稱(...) 完全不用改。
 *  - 讀取：直接查 Supabase 資料表（受 RLS 保護，未登入/未啟用帳號讀不到）
 *  - 寫入預約單：呼叫資料庫 RPC（驗證、碼頭指派、鎖定都在資料庫內完成）
 */
(function () {
  const TZ = 'Asia/Taipei';
  const LATE_SLOT = '17:00 以後';
  const sb = () => window.dockSb;

  // ---------- 工具 ----------
  function tpeParts(d) {
    const p = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(d || new Date()).forEach(x => { p[x.type] = x.value; });
    return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
  }
  const todayTpe = () => tpeParts().date;
  const nowHm = () => tpeParts().hm;

  function check(res) {
    if (res.error) {
      const e = new Error(res.error.message || String(res.error));
      e.code = res.error.code;
      throw e;
    }
    return res.data;
  }

  // Supabase 單次查詢最多回傳 1000 筆，這裡自動分頁抓完
  async function fetchAll(build) {
    const size = 1000;
    let from = 0, out = [];
    for (;;) {
      const rows = check(await build().range(from, from + size - 1));
      out = out.concat(rows || []);
      if (!rows || rows.length < size) return out;
      from += size;
    }
  }

  async function rpc(fn, params) {
    return check(await sb().rpc(fn, params || {}));
  }

  // 主資料（碼頭、單位、人員、設定）同一頁面 60 秒內只讀一次
  let masterMemo = null, masterTime = 0;
  async function master() {
    if (masterMemo && Date.now() - masterTime < 60000) return masterMemo;
    const [units, docks, staff, config] = await Promise.all([
      sb().from('units').select('*').order('sort').order('unit'),
      sb().from('docks').select('*').order('sort').order('name'),
      sb().from('staff').select('*').order('sort').order('name'),
      sb().from('app_config').select('*').eq('id', 1).maybeSingle()
    ]).then(rs => rs.map(check));
    const unitWeights = {};
    (units || []).forEach(u => { unitWeights[u.unit] = Number(u.weight); });
    masterMemo = {
      unitList: (units || []).map(u => u.unit),
      unitWeights: Object.keys(unitWeights).length ? unitWeights : { '板': 1.0, '瓶': 0.167, '桶': 0.25, '箱': 0.125, '車': 1.0, '櫃': 1.0 },
      dockList: (docks || []).map(d => d.name),
      staffList: (staff || []).map(s => s.name),
      dailyPalletLimit: (config && config.daily_pallet_limit_in > 0) ? config.daily_pallet_limit_in : 200
    };
    masterTime = Date.now();
    return masterMemo;
  }

  function calcPallets(qty, unit, weights) {
    const n = Number(qty) || 0;
    if (n <= 0) return 0;
    const w = weights[unit] !== undefined ? weights[unit] : 1.0;
    return Math.ceil(n * w);
  }

  function fmtCreatedAt(ts) {
    if (!ts) return '';
    const p = tpeParts(new Date(ts));
    return `${p.date} ${p.hm}`;
  }

  // 資料庫欄位 → 原本 Apps Script 回傳的欄位名稱
  function toBooking(r) {
    return {
      bookingId: r.booking_id,
      createdBy: r.created_by || '',
      operationType: r.operation_type || '',
      taxType: r.tax_type || '',
      priority: r.priority || '',
      customerName: r.customer_name || '',
      productName: r.product_name || '',
      quantity: Number(r.quantity) || 0,
      unit: r.unit || '',
      convertedPallets: Number(r.converted_pallets) || 0,
      tempControl: r.temp_control || '',
      carrier: r.carrier || '',
      vehicleType: r.vehicle_type || '',
      plateNumber: r.plate_number || '',
      driverName: r.driver_name || '',
      driverPhone: r.driver_phone || '',
      etaDate: r.eta_date,
      etaTimeSlot: r.eta_time_slot || '',
      assignedDock: (r.assigned_dock || '').trim(),
      origin: r.origin || '',
      containerType: r.container_type || '',
      containerNumber: r.container_number || '',
      status: r.status || '',
      remarks: r.remarks || ''
    };
  }

  async function dutyFor(dateStr) {
    const row = check(await sb().from('duty').select('*').eq('duty_date', dateStr).maybeSingle());
    return { warehouseStaff: row ? row.warehouse_staff : '', csStaff: row ? row.cs_staff : '' };
  }

  async function dataToken() {
    const row = check(await sb().from('data_version').select('ver').eq('id', 1).maybeSingle());
    const hm = nowHm().split(':').map(Number);
    const bucket = Math.floor((hm[0] * 60 + hm[1] - 1) / 30);   // 每半小時重抓一次（逾時判斷會隨時間改變）
    return (row ? row.ver : 0) + '|' + bucket;
  }

  function escLike(s) { return String(s).replace(/[\\%_]/g, m => '\\' + m); }

  // ---------- 看板 ----------
  async function buildDashboardData(targetDateStr) {
    const m = await master();
    const todayStr = todayTpe();
    const queryDate = targetDateStr || todayStr;
    const hm = nowHm();
    const rows = await fetchAll(() => sb().from('bookings').select('*')
      .eq('eta_date', queryDate).neq('status', '取消').order('eta_time_slot').order('booking_id'));
    const nonOverdue = ['已完成', '已放行離廠', '簽到', '已到廠', '作業中', '放行', '離廠'];
    const notifications = [];
    const bookings = rows.map(r => {
      const b = toBooking(r);
      const isOverdue = queryDate === todayStr && hm > b.etaTimeSlot && !nonOverdue.includes(b.status);
      if (isOverdue) notifications.push({ bookingId: b.bookingId, customerName: b.customerName, etaTimeSlot: b.etaTimeSlot });
      return Object.assign(b, {
        convertedPallets: calcPallets(b.quantity, b.unit, m.unitWeights),
        tempControl: b.tempControl || '常溫',
        assignedDock: b.assignedDock || (m.dockList[0] || '1號標準碼頭'),
        isOverdue: isOverdue
      });
    });
    const duty = await dutyFor(queryDate);
    return {
      success: true,
      queryDate: queryDate,
      currentTime: hm,
      dockList: m.dockList,
      bookings: bookings,
      notifications: notifications,
      warehouseStaff: duty.warehouseStaff || '未設定',
      csStaff: duty.csStaff || '未設定'
    };
  }

  // ---------- 對外功能（名稱 = 原本 Apps Script 的功能名稱） ----------
  const Api = {
    async getWebAppUrl() {
      return new URL('index.html', location.href).href;
    },

    async getDataVersion() {
      return { token: await dataToken(), time: nowHm() };
    },

    async getDashboardDataByDate(targetDateStr) {
      const token = await dataToken();
      const res = await buildDashboardData(targetDateStr);
      res.dataToken = token;
      return res;
    },

    async getGatekeeperDashboardData() {
      const token = await dataToken();
      const d = await buildDashboardData(todayTpe());
      const bookings = d.bookings.map(b => Object.assign({}, b, {
        carrier: b.carrier || '未指定',
        driverPhone: b.driverPhone || '無電話'
      })).sort((a, b) => (a.etaTimeSlot < b.etaTimeSlot ? -1 : a.etaTimeSlot > b.etaTimeSlot ? 1 : 0));
      const occupied = new Set(bookings.filter(b => (b.status === '已到廠' || b.status === '作業中') && b.assignedDock).map(b => b.assignedDock));
      return {
        success: true,
        dataToken: token,
        bookings: bookings,
        dockStatus: d.dockList.map(dock => ({ dockName: dock, isAvailable: !occupied.has(dock), statusText: occupied.has(dock) ? '使用中' : '空碼頭' })),
        warehouseStaff: d.warehouseStaff,
        csStaff: d.csStaff
      };
    },

    async updateVehicleGateStatus(bookingId, newStatus) {
      return rpc('update_vehicle_gate_status', { p_id: String(bookingId), p_status: String(newStatus) });
    },

    // ---------- 客服預約頁 ----------
    async getIndexInitData() {
      const m = await master();
      const todayStr = todayTpe();
      const [rows, lockRules] = await Promise.all([
        fetchAll(() => sb().from('bookings').select('*').gte('eta_date', todayStr).neq('status', '取消').order('booking_id')),
        Api.getLockRules()
      ]);
      return {
        success: true,
        todayStr: todayStr,
        staffList: m.staffList.length ? m.staffList : ['張小明', '李大華', '王客服', '楊客服'],
        unitList: m.unitList,
        unitWeights: m.unitWeights,
        dockList: m.dockList,
        lockRules: lockRules,
        dailyPalletLimit: m.dailyPalletLimit,
        bookings: rows.map(toBooking)
      };
    },

    async searchBookingForEdit(keyword) {
      const kw = escLike(String(keyword || '').trim());
      if (!kw) return { success: false, message: '未找到符合的有效預約單號或車牌！' };
      for (const col of ['booking_id', 'plate_number']) {
        const rows = check(await sb().from('bookings').select('*').ilike(col, kw).neq('status', '取消')
          .order('eta_date', { ascending: false }).limit(1));
        if (rows && rows.length) return { success: true, booking: toBooking(rows[0]) };
      }
      return { success: false, message: '未找到符合的有效預約單號或車牌！' };
    },

    async cancelBookingFromEdit(bookingId) {
      return rpc('cancel_booking_from_edit', { p_id: String(bookingId) });
    },

    async processBookingSubmission(formData) {
      return rpc('process_booking_submission', { f: formData });
    },

    async updateBookingSubmission(formData) {
      return rpc('update_booking_submission', { f: formData });
    },

    // ---------- 主管後台 ----------
    async getAdminDashboardData(targetDateStr) {
      const m = await master();
      const rows = await fetchAll(() => sb().from('bookings').select('*').eq('eta_date', targetDateStr).order('eta_time_slot').order('booking_id'));
      let totalPallets = 0;
      const list = rows.map(r => {
        const b = toBooking(r);
        const pallets = calcPallets(b.quantity, b.unit, m.unitWeights);
        if (b.status !== '取消') totalPallets += pallets;
        return {
          bookingId: b.bookingId,
          createdAt: fmtCreatedAt(r.created_at),
          customerName: b.customerName,
          productName: b.productName,
          operationType: b.operationType,
          taxType: b.taxType,
          priority: b.priority,
          quantity: b.quantity,
          unit: b.unit,
          convertedPallets: pallets,
          vehicleType: b.vehicleType,
          plateNumber: b.plateNumber,
          etaDate: b.etaDate,
          etaTimeSlot: b.etaTimeSlot,
          assignedDock: b.assignedDock || '未指派',
          status: b.status || '預約中',
          completedAt: r.completed_at || '',
          remark: b.remarks
        };
      });
      return { success: true, totalPallets: totalPallets, dailyPalletLimit: m.dailyPalletLimit, bookings: list };
    },

    async updateAdminBooking(bookingId, newDock, newStatus, newRemark, newDate, newSlot) {
      return rpc('update_admin_booking', {
        p_id: String(bookingId), p_dock: newDock || '', p_status: newStatus || '',
        p_remark: newRemark || '', p_date: newDate || '', p_slot: newSlot || ''
      });
    },

    async getLockRules() {
      const rows = check(await sb().from('lock_rules').select('*').order('lock_date').order('id'));
      return (rows || []).map(r => ({
        rowIndex: r.id,                // 原本是 Sheet 列號，現在改用資料庫 id（刪除時使用）
        lockDate: r.lock_date,
        lockDock: (r.lock_dock || '').trim(),
        lockTimeSlot: (r.lock_time_slot || '').trim(),
        reason: (r.reason || '').trim()
      }));
    },

    async addLockRule(lockData) {
      if (!lockData || !lockData.date) return { success: false, message: '請選擇鎖定日期' };
      check(await sb().from('lock_rules').insert({
        lock_date: lockData.date, lock_dock: lockData.dock || 'ALL',
        lock_time_slot: lockData.timeSlot || 'ALL', reason: lockData.reason || ''
      }));
      return { success: true, message: '碼頭鎖定規則儲存成功！' };
    },

    async deleteLockRule(id) {
      if (!id) return { success: false, message: '無效的資料行數' };
      check(await sb().from('lock_rules').delete().eq('id', id));
      return { success: true, message: '鎖定規則刪除成功！' };
    },

    async getDutySchedule(dateStr) {
      const d = await dutyFor(dateStr);
      return { success: true, warehouseStaff: d.warehouseStaff, csStaff: d.csStaff };
    },

    async saveDutyScheduleRange(startDateStr, endDateStr, staffName, staffType) {
      const col = staffType === 'warehouse' ? 'warehouse_staff' : staffType === 'cs' ? 'cs_staff' : '';
      if (!col || !startDateStr || !endDateStr || startDateStr > endDateStr) {
        return { success: false, message: '日期區間格式不正確或開始日期大於結束日期！' };
      }
      const rows = [];
      const s = startDateStr.split('-').map(Number);
      for (let t = Date.UTC(s[0], s[1] - 1, s[2]); ; t += 86400000) {
        const ds = new Date(t).toISOString().slice(0, 10);
        if (ds > endDateStr) break;
        rows.push({ duty_date: ds, [col]: staffName || '' });
      }
      // upsert 只會更新有傳的欄位，另一種值班人員不會被清掉
      check(await sb().from('duty').upsert(rows, { onConflict: 'duty_date' }));
      return { success: true, message: `值班排班已成功套用至 ${startDateStr} ~ ${endDateStr}！` };
    },

    async saveDutySchedule(dateStr, warehouseStaff, csStaff) {
      check(await sb().from('duty').upsert({ duty_date: dateStr, warehouse_staff: warehouseStaff || '', cs_staff: csStaff || '' }, { onConflict: 'duty_date' }));
      return { success: true, message: '值班設定更新完成！' };
    },

    async getRangeReport(startDateStr, endDateStr) {
      if (!startDateStr || !endDateStr || startDateStr > endDateStr) {
        return { success: false, message: '請選擇正確的起訖日期' };
      }
      const m = await master();
      const rows = await fetchAll(() => sb().from('bookings').select('booking_id,eta_date,operation_type,quantity,unit,status')
        .gte('eta_date', startDateStr).lte('eta_date', endDateStr).neq('status', '取消').order('booking_id'));
      const dailyPallets = {};
      const s = startDateStr.split('-').map(Number);
      for (let t = Date.UTC(s[0], s[1] - 1, s[2]); ; t += 86400000) {
        const ds = new Date(t).toISOString().slice(0, 10);
        if (ds > endDateStr) break;
        dailyPallets[ds] = 0;
      }
      const summary = { totalBookings: 0, totalPallets: 0, inboundPallets: 0, outboundPallets: 0,
                        inboundVehicles: 0, outboundVehicles: 0, unitSummary: {}, dailyPallets: dailyPallets };
      rows.forEach(r => {
        const qty = Number(r.quantity) || 0;
        const unit = (r.unit || '').trim();
        const pallets = calcPallets(qty, unit, m.unitWeights);
        summary.totalBookings++;
        summary.totalPallets += pallets;
        summary.dailyPallets[r.eta_date] = (summary.dailyPallets[r.eta_date] || 0) + pallets;
        if (r.operation_type === '進貨') { summary.inboundPallets += pallets; summary.inboundVehicles++; }
        else if (r.operation_type === '出貨') { summary.outboundPallets += pallets; summary.outboundVehicles++; }
        if (unit) summary.unitSummary[unit] = (summary.unitSummary[unit] || 0) + qty;
      });
      return { success: true, summary: summary };
    }
  };

  window.DockApi = Api;
  window.DOCK_LATE_SLOT = LATE_SLOT;
})();
