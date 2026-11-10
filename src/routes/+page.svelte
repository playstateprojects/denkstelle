<script lang="ts">
  import {useI18n} from '$lib/i18n';
  const {t}=useI18n();
</script>
<div class="main">
  <header class="row" style="justify-content:space-between"><strong>{t('common.brand')}</strong><a href="/dashboard">{t('home.dashboardLink')}</a></header>
  <section style="padding:11vh 0 8vh;max-width:780px">
    <div class="eyebrow">{t('home.eyebrow')}</div>
    <h1 class="headline">{t('home.headlineA')}<br/>{t('home.headlineB')} <span class="mark">{t('home.headlineC')}</span></h1>
    <p style="font-size:1.3rem;line-height:1.5">{t('home.lead')}</p>
    <div class="row" style="margin-top:30px;flex-wrap:wrap"><a class="btn" href="/dashboard">{t('home.create')}</a><a class="btn secondary" href="/manage">{t('home.manage')}</a></div>
  </section>
  <section class="grid"><div class="panel"><div class="eyebrow">01</div><h2>{t('home.p1.title')}</h2><p class="muted">{t('home.p1.text')}</p></div><div class="panel"><div class="eyebrow">02</div><h2>{t('home.p2.title')}</h2><p class="muted">{t('home.p2.text')}</p></div><div class="panel"><div class="eyebrow">03</div><h2>{t('home.p3.title')}</h2><p class="muted">{t('home.p3.text')}</p></div></section>
</div>
